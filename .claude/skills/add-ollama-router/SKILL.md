---
name: add-ollama-router
description: Intercepts simple factual queries and privacy queries before spinning up a Claude agent, sending them directly to a local Ollama instance to save Anthropic API costs and protect sensitive local data.
---

# Add Ollama Router

This skill adds a hybrid router that intercepts messages in the core loop before sending them to Claude. Short questions and keywords identified in `llm-routing.json` bypass Claude and hit the local Ollama service instead.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `ollama-router` is in `applied_skills`, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

Run the skills engine to apply the code package:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-ollama-router
```

This injects the Ollama interceptor directly into the `src/index.ts` message loop and adds `src/llm-router.ts` and `src/ollama-client.ts`.

## Phase 3: Configuration

The user must configure their `.env` and create a `llm-routing.json` in the project root if it does not already exist.

Sample `llm-routing.json`:
```json
{
  "enabled": true,
  "ollama": {
    "baseUrl": "http://192.168.1.100:11434",
    "timeoutMs": 15000,
    "models": {
      "simple": "llama3.2",
      "general": "llama3",
      "reasoning": "deepseek-r1"
    }
  },
  "routing": {
    "maxWordsForSimple": 15,
    "privacyKeywords": [
      "password",
      "secret",
      "my address"
    ],
    "simpleStarters": [
      "what",
      "who",
      "when",
      "where",
      "why",
      "how",
      "is",
      "are",
      "do",
      "does"
    ]
  }
}
```

Wait until they configure the URL.

## Phase 4: Validation

After applying and configuring, verify the build passes.
```bash
npm run build
```
