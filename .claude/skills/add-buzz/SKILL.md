---
name: add-buzz
description: Add Buzz (Block's Nostr-relay agent/human workspace) as a channel. Native adapter — NIP-29 group messages over a Nostr relay, NIP-42 auth. MVP scope is channel/group messages only; NIP-17 DMs are a documented fast-follow, not yet built.
---

# Add Buzz Channel

Buzz (github.com/block/buzz) is Block's open-source Nostr-relay-based workspace where humans and agents share channels. This adapter connects NanoClaw directly to a Buzz relay as a plain Nostr client — no `buzz-acp`/`claude-agent-acp` bridge involved, since `agent-runner` already is the agent loop.

Buzz channels are [NIP-29](https://github.com/nostr-protocol/nips/blob/master/29.md) relay-groups: messages are `kind:9` events tagged `#h`=`<channel-uuid>`; membership/metadata are relay-signed `kind:39000`/`39002` events. Auth is [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) challenge-response. Verified against Buzz's own `NOSTR.md` protocol doc, not assumed.

**MVP scope: channel/group messages only.** NIP-17 encrypted DMs are a documented fast-follow — no DM inbound/outbound path exists yet.

This adapter isn't fetched from the `channels` registry branch (it's not an upstream-contributed channel) — its canonical source lives in this skill's `resources/` directory, copied straight into `src/channels/`, same pattern as `/add-dashboard`.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/buzz.ts` exists
- `src/channels/buzz-registration.test.ts` and `src/channels/buzz.test.ts` exist
- `src/channels/index.ts` contains `import './buzz.js';`
- `nostr-tools` and `ws` are listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Copy the adapter and its tests

```bash
cp .claude/skills/add-buzz/resources/buzz.ts src/channels/buzz.ts
cp .claude/skills/add-buzz/resources/buzz-registration.test.ts src/channels/buzz-registration.test.ts
cp .claude/skills/add-buzz/resources/buzz.test.ts src/channels/buzz.test.ts
```

### 2. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './buzz.js';
```

### 3. Install dependencies (pinned exact versions)

`nostr-tools` provides NIP-01/29/42 event handling and relay connection management (including the full NIP-42 handshake and reconnect-with-backoff — the adapter doesn't hand-roll the wire protocol). `ws` supplies the WebSocket implementation: the host is only guaranteed Node ≥20 (CI-pinned to exactly 20), and Node has no stable global `WebSocket` until Node 22.

Check both packages clear the 3-day `minimumReleaseAge` gate (`pnpm-workspace.yaml`) before pinning — `npm view <pkg> time` or just let `pnpm install` below fail loudly if not:

```bash
pnpm install nostr-tools@2.24.1 ws@8.21.3
pnpm install -D @types/ws@8.18.1
```

### 4. Build and validate

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run src/channels/buzz-registration.test.ts src/channels/buzz.test.ts
```

`buzz-registration.test.ts` imports the real channel barrel and asserts the registry contains `buzz` — it goes red if the barrel import is deleted/drifts, or if `nostr-tools`/`ws` aren't installed (the import throws), so it also covers the dependency from step 3. `buzz.test.ts` is the behavioral test: fakes the `ws` transport and exercises the real (unmocked) `nostr-tools` library against it — NIP-42 handshake, group discovery/membership filtering, echo-skip, mention detection, `deliver()`'s event shape, and the `NetworkError` tagging that gets a connection failure retried by `channel-registry.ts`. Importing the barrel is safe: `buzz.ts` only connects to the relay inside `setup()` (run at host startup), never at import.

End-to-end delivery against a real relay is verified manually once the service is running — see Wiring and Troubleshooting.

## Credentials

Buzz identity is a Nostr keypair. **This adapter never generates a key or requests channel membership** — it reuses an existing identity that's already been invited into the workspace and whatever channels it should read/post to. If you don't already have one, generate it with Buzz's own tooling (`buzz-admin generate-key` on the relay host, or any Nostr key generator) and have an admin add it as a workspace/channel member first — the adapter connecting with a fresh, non-member key will authenticate fine and then sit idle (see Troubleshooting).

Add to `.env`:

```bash
BUZZ_RELAY_URL=ws://10.0.99.13:3000   # your relay's websocket URL
BUZZ_NSEC=nsec1...                     # existing identity's private key, bech32 form
```

**`BUZZ_NSEC` is a private key — treat it like any other credential.** The adapter decodes the bech32 `nsec1...` form internally (`nostr-tools/nip19`); don't convert it to hex yourself.

### Restart

This install runs NanoClaw as a system-level `systemd` service:

```bash
sudo systemctl restart nanoclaw
```

(A per-install unit derived via `setup/lib/install-slug.sh` — `systemctl --user restart $(systemd_unit)` on Linux, `launchctl kickstart -k gui/$(id -u)/$(launchd_label)` on macOS — is the general path if this fork is running some other way.)

## Wiring

The adapter connects, authenticates, and discovers which channels the identity is a member of at startup — check `logs/nanoclaw.log`:

```bash
grep buzz logs/nanoclaw.log | grep -E "channel connected|metadata discovered"
```

**`onMetadata` doesn't create a `messaging_groups` row by itself** (true for every native adapter, not buzz-specific — it only logs). Normally a channel becomes wireable after its first real inbound message that's a **mention** — but confirmed against real Buzz clients (desktop UI): an `@mention` is literal text in the message, not a `p` tag, so `isMention` never fires and auto-registration never triggers. **In practice, always pre-create the `messaging_groups` row and wiring manually** rather than waiting on a first message:

```bash
ncl messaging-groups create \
  --channel-type buzz \
  --platform-id buzz:<channel-uuid> \
  --instance buzz \
  --name <channel-name> \
  --is-group 1

ncl wirings create \
  --messaging-group-id <mg-id-from-above> \
  --agent-group-id <ag-id>
```

`<channel-uuid>` comes from `grep "Channel metadata discovered" logs/nanoclaw.log | grep buzz`. The declared default engage mode is `pattern` matching the agent's name (see Channel Info) — override with `--engage-mode pattern --engage-pattern '.'` at wiring time for always-on, if the channel is low-traffic enough that a name pattern isn't worth requiring.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire a Buzz channel to an agent group once a `messaging_groups` row exists for it (see Wiring above).

## Channel Info

- **type**: `buzz`
- **terminology**: Buzz calls a NIP-29 relay-group a "channel"
- **supports-threads**: no — one shared session per channel (NIP-29 channels are flat, like Signal/Telegram, not Discord-style threads)
- **platform-id-format**: `buzz:<channel-uuid>` (the NIP-29 group's `d`-tag identifier)
- **user-id-format**: `buzz:<pubkey-hex>`
- **how-to-find-id**: query `messaging_groups` as shown above, after a first message has been posted in the target channel
- **mentions**: `never` — real Buzz clients put `@mentions` in message text, not `p` tags, so platform mention detection isn't reliable (see Wiring). Group engagement defaults to a name-pattern match instead.
- **default-isolation**: one agent per Buzz identity/relay is the simplest model — multiple channels the identity belongs to can share an agent group, or be wired to separate ones, same tradeoff as any other multi-channel adapter

### Not supported (MVP)

- **DMs** — NIP-17 gift-wrapped DMs are a fast-follow, not built. Only channel/group messages work.
- **File attachments** — no Buzz-implemented NIP covers this; `deliver()` logs a warning and drops any files on an outbound message.
- **Typing/presence** — Buzz's `kind:20001`/`20002` are ephemeral/Redis-pub/sub-only; `setTyping` is not implemented.
- **Reactions, threading, search** (NIP-25/10/50) — Buzz supports these but the adapter doesn't use them.

## Troubleshooting

### Adapter not starting — credentials missing

```bash
grep "BUZZ_RELAY_URL/BUZZ_NSEC not set" logs/nanoclaw.log
```

Both vars must be present in `.env`. If `BUZZ_NSEC` is present but malformed:

```bash
grep "not a valid nsec1" logs/nanoclaw.log
```

### Connects fine but discovers zero channels — "looks-fine-but-empty"

```bash
grep "is not a member of any discovered group" logs/nanoclaw.log
```

The identity authenticated successfully but isn't a member of any channel on the relay — usually means a fresh key was used instead of an already-invited one (see Credentials). Have an admin add the pubkey as a member, then restart.

### Connection keeps failing / retries exhausted

```bash
grep "Buzz:" logs/nanoclaw.error.log | tail -20
```

`channel-registry.ts` retries `setup()` 3x (2s/5s/10s backoff) on a tagged `NetworkError`, then gives up until the next restart. Check `BUZZ_RELAY_URL` is reachable from the NanoClaw host (`curl -s <relay-http-url>/_liveness` or equivalent) and that the identity's pubkey isn't blocked by the relay's allowlist if one is configured (`BUZZ_PUBKEY_ALLOWLIST`).

### Relay connection drops and never recovers

`nostr-tools`' own reconnect (`enableReconnect: true`) handles most drops automatically. A defensive 5-minute health check in the adapter watches for the case where reconnect gets stuck disabled (a known library edge case on error-flavored drops) and force-retries:

```bash
grep "relay unexpectedly disconnected" logs/nanoclaw.log
```

If this fires repeatedly without recovering, the relay itself is likely down — check it directly.

### Messages received but agent not responding

The messaging group probably isn't wired — auto-registration needs a mention, which real Buzz clients don't reliably produce (see Wiring). Check:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='buzz'"
```

If no row exists, create and wire it manually (Wiring section above). If a row exists but engagement never triggers, the default `pattern` engage mode requires the agent's name to appear in the message; switch to always-on for a low-traffic channel:

```bash
ncl wirings update <wiring-id> --engage-mode pattern --engage-pattern '.'
```

### File attachments silently missing

Expected — see Not Supported above. Check for the drop log:

```bash
grep "file attachments are not supported" logs/nanoclaw.log
```
