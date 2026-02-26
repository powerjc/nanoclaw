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

type RouteDecision = 'ollama-simple' | 'ollama-privacy' | 'claude';

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

/**
 * Extract the last user-visible text from the message list.
 * Strips the @BotName trigger prefix if present.
 */
function extractLastUserText(messages: NewMessage[]): string {
  // Find last non-assistant message
  const userMessages = messages.filter((m) => !m.is_from_me && !m.is_bot_message);
  const last = userMessages.length > 0 ? userMessages[userMessages.length - 1] : messages[messages.length - 1];
  // Strip @mention trigger prefix (e.g. "@Andy What is 2+2?" → "What is 2+2?")
  return last.content.replace(/^@\S+\s*/u, '').trim();
}

function hasPrivacyKeyword(messages: NewMessage[], keywords: string[]): boolean {
  const allText = messages.map((m) => m.content).join(' ').toLowerCase();
  return keywords.some((kw) => {
    const pattern = new RegExp(`\\b${kw.toLowerCase().replace(/\s+/g, '\\s+')}\\b`);
    return pattern.test(allText);
  });
}

function isSimpleQuestion(text: string, maxWords: number, simpleStarters: string[]): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length > maxWords) return false;
  if (!text.includes('?')) return false;
  const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '');
  return simpleStarters.includes(firstWord);
}

export function classifyMessages(messages: NewMessage[]): RouteDecision {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) return 'claude';

  const { routing } = cfg;

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
