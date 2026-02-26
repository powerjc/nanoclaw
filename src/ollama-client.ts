import { logger } from './logger.js';

interface OllamaGenerateResponse {
  response: string;
  model: string;
  done: boolean;
}

/**
 * Send a prompt to a local Ollama server and return the generated text.
 * Throws on HTTP errors, network failures, or timeout.
 */
export async function queryOllama(
  prompt: string,
  model: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    if (!data.done || typeof data.response !== 'string') {
      throw new Error('Unexpected Ollama response format');
    }

    logger.debug({ model, baseUrl }, 'Ollama query succeeded');
    return data.response.trim();
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Ollama timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
