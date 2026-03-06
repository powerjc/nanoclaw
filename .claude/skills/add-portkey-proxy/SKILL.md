---
name: add-portkey-proxy
description: Installs an in-process Portkey AI Gateway to route NanoClaw's Anthropic API calls to Gemini 3.1 Pro (or other models). Avoids needing a separate Docker container for proxying. Supports on-the-fly model switching via `/model <name>`.
---

# Add Portkey Proxy

This skill injects the open-source Portkey AI Gateway into the NanoClaw container runner using the skills engine for deterministic code changes. This allows translating Anthropic Messages API calls to the Google Gemini API (or other providers) natively inside the Node.js process. It also adds a magic `/model` command to switch providers on the fly.

## Phase 1: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this `SKILL.md`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-portkey-proxy
```

This deterministically:
- Installs the `@portkey-ai/gateway` npm dependency
- Adds `container/agent-runner/src/proxy.ts`
- Merges modifications into `container/agent-runner/src/index.ts` to boot the gateway prior to agent evaluation and injects the `/model` interceptor
- Adds `GEMINI_API_KEY` and `ANTHROPIC_BACKUP_KEY` to the `.env.example` file
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/container/agent-runner/src/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
cd container/agent-runner && npm run build
cd ../..
```

## Phase 2: Setup

### Configure Environment

Use `AskUserQuestion` to ask the user which backup API key they want to provide. They should at least provide `GEMINI_API_KEY`. If they want to use automatic fallbacks when the primary model fails, they should also provide an `ANTHROPIC_BACKUP_KEY`.

Wait for the user to provide the keys.

Add the provided keys to the `.env` file in the project root:

```bash
GEMINI_API_KEY=<their-key>
ANTHROPIC_BACKUP_KEY=<their-fallback-key> # Optional
```

### Sync Environment

Channels auto-enable when their credentials are present. Sync the `.env` file to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 3: Build and Restart

```bash
npm run build
```

Then tell the user to restart their NanoClaw service to pick up the changes:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
# systemctl --user restart nanoclaw
```

## Phase 4: Verify

Once restarted:
1. NanoClaw will automatically route all traffic through Portkey.
2. The user can type `/model gemini`, `/model openai`, or `/model claude` in any chat to instantly hot-swap the backing LLM for that specific group!
