import { createGateway } from '@portkey-ai/gateway';
import fs from 'fs';
import path from 'path';

const MODEL_CONFIG_PATH = '/workspace/group/.current-model';

function getCurrentProvider(): string {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      const model = fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8').trim().toLowerCase();
      // Map friendly names to Portkey providers
      if (model === 'gemini') return 'google';
      if (model === 'openai') return 'openai';
      if (model === 'perplexity') return 'perplexity';
      if (model === 'claude' || model === 'anthropic') return 'anthropic';
      return model; // Pass raw strings if user inputs a specific explicit provider
    }
  } catch (err) {
    // Ignore read errors
  }
  return 'google'; // Default provider if no config
}

/**
 * Starts a local Portkey AI Gateway on port 4000.
 * Includes dynamic file-based routing and automatic fallbacks on 429/500 errors.
 */
export async function startProxy(): Promise<number> {
  const port = 4000;

  // Create an Express-compatible handler with dynamic routing
  const gatewayApp = createGateway({
    // We use a custom configuration resolver to read the file on every request
    config: () => {
      const provider = getCurrentProvider();

      return {
        strategy: {
          mode: 'fallback'
        },
        targets: [
          {
            provider: provider,
            // Portkey will auto-resolve the API key from process.env.[PROVIDER]_API_KEY
            // if we don't explicitly pass one, so we just pass the desired provider dynamically.
            virtual_key: provider === 'google' ? process.env.GEMINI_API_KEY : undefined
          },
          {
            // Automatic Fallback Strategy:
            // If the primary model fails (e.g., rate limit), transparently fallback to Anthropic
            provider: 'anthropic',
            virtual_key: process.env.ANTHROPIC_BACKUP_KEY
          }
        ]
      };
    }
  });

  return new Promise((resolve) => {
    gatewayApp.listen(port, () => {
      resolve(port);
    });
  });
}
