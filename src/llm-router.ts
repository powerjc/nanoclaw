import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { queryOllama } from './ollama-client.js';
import { NewMessage } from './types.js';

interface RoutingConfig {
  enabled: boolean;
  ollama: {
    baseUrl: string;
    timeoutMs: number;
    models: {
      simple: string;
      general: string;
      reasoning: string;
    };
  };
  routing: {
    maxWordsForSimple: number;
    privacyKeywords: string[];
    simpleStarters: string[];
  };
}

type RouteDecision = 'ollama-forced' | 'ollama-simple' | 'ollama-privacy' | 'claude';

// Cached config — loaded once from disk
let cachedConfig: RoutingConfig | null = null;

function loadConfig(): RoutingConfig | null {
  if (cachedConfig) return cachedConfig;
  const configPath = path.resolve(process.cwd(), 'llm-routing.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    cachedConfig = JSON.parse(raw) as RoutingConfig;
    logger.info({ configPath }, 'LLM routing config loaded');
    return cachedConfig;
  } catch (err) {
    logger.warn({ err, configPath }, 'LLM routing config not found or invalid, routing disabled');
    return null;
  }
}

function lastUserMessage(messages: NewMessage[]): NewMessage {
  const userMessages = messages.filter((m) => !m.is_from_me && !m.is_bot_message);
  return userMessages.length > 0 ? userMessages[userMessages.length - 1] : messages[messages.length - 1];
}

/**
 * Strip @mention and !local prefix, returning the bare query text.
 */
function extractLastUserText(messages: NewMessage[]): string {
  return lastUserMessage(messages).content
    .replace(/^@\S+\s*/u, '')   // strip @Andy trigger
    .replace(/^!local\s*/i, '') // strip !local prefix
    .trim();
}

/**
 * Text after stripping only the @mention — used to detect !local before removing it.
 */
function mentionStripped(messages: NewMessage[]): string {
  return lastUserMessage(messages).content.replace(/^@\S+\s*/u, '').trim();
}

function hasPrivacyKeyword(messages: NewMessage[], keywords: string[]): boolean {
  const allText = messages.map((m) => m.content).join(' ').toLowerCase();
  return keywords.some((kw) => {
    const pattern = new RegExp(`\\b${kw.toLowerCase().replace(/\s+/g, '\\s+')}\\b`);
    return pattern.test(allText);
  });
}

// Starters that don't require a '?' (imperative lookups)
const COMMAND_STARTERS = new Set(['define', 'explain']);

function isSimpleQuestion(text: string, maxWords: number, simpleStarters: string[]): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length > maxWords) return false;
  const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!simpleStarters.includes(firstWord)) return false;
  // Command-style starters (define, explain) don't need a '?'
  return COMMAND_STARTERS.has(firstWord) || text.includes('?');
}

export function classifyMessages(messages: NewMessage[]): RouteDecision {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) return 'claude';

  const { routing } = cfg;

  // Priority 0: explicit !local signal — user-requested local execution
  if (/^!local\b/i.test(mentionStripped(messages))) {
    return 'ollama-forced';
  }

  // Priority 1: privacy keywords → keep local
  if (hasPrivacyKeyword(messages, routing.privacyKeywords)) {
    return 'ollama-privacy';
  }

  // Priority 2: short factual questions → local
  const userText = extractLastUserText(messages);
  if (isSimpleQuestion(userText, routing.maxWordsForSimple, routing.simpleStarters)) {
    return 'ollama-simple';
  }

  return 'claude';
}

/**
 * Try to route messages to Ollama. Returns the formatted response string,
 * or null if the message should be handled by Claude instead.
 *
 * Returning null means: fall through to the normal Claude container path.
 */
export async function tryOllamaRoute(
  messages: NewMessage[],
  groupName: string,
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) return null;

  const decision = classifyMessages(messages);

  if (decision === 'claude') {
    logger.debug({ group: groupName }, 'LLM router: Claude');
    return null;
  }

  const userText = extractLastUserText(messages);
  const model =
    decision === 'ollama-simple' ? cfg.ollama.models.simple : cfg.ollama.models.general;
  // ollama-forced and ollama-privacy both use the general model

  logger.info(
    { group: groupName, decision, model, query: userText.slice(0, 120) },
    'LLM router: Ollama',
  );

  try {
    const response = await queryOllama(
      userText,
      model,
      cfg.ollama.baseUrl,
      cfg.ollama.timeoutMs,
    );

    const indicator = decision === 'ollama-privacy' ? '🔒 [Private]' : '🤖 [Local]';
    logger.info({ group: groupName, decision, model }, 'Ollama response received');
    return `${indicator} ${response}`;
  } catch (err) {
    logger.warn({ group: groupName, decision, err }, 'Ollama failed, falling back to Claude');
    return null;
  }
}
