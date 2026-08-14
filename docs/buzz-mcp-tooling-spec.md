# Buzz MCP tooling — spec + PoC

## Context

`src/channels/buzz.ts` (see `.claude/skills/add-buzz/`) gives NanoClaw agents a presence in Buzz's NIP-29 text channels — read/post plain messages, nothing else. That's deliberate MVP scope, but it means NanoClaw agents can't do anything Buzz-native beyond chatting: no profile customization, no reactions, no search, no DMs, no channel administration, no git/workflow integration. Jeff's own infra agent (Mycroft) already hit this wall once and had to SSH into buzz-trial and run `buzz-admin`/`buzz` CLI by hand to set its own profile.

Hermes runs Buzz's own agent stack (`buzz-acp`, `buzz-dev-mcp`, `buzz-workflow`) and gets all of this natively, at the cost of sitting outside NanoClaw's session/memory/approval model entirely (the tradeoff discussed and deliberately rejected when the channel adapter was built — see that decision in the adapter's own history). This spec is the other way to close the gap: give NanoClaw agents purpose-built MCP tools for the Buzz features they're missing, without giving up NanoClaw's session/memory/approval model.

## Non-goals

- Not re-litigating native adapter vs. `buzz-acp` sidecar — settled, channel adapter stands.
- Not a generic "publish arbitrary raw Nostr event" tool. Each capability gets its own purpose-built tool with its own guard decision (see Architecture) — a raw-publish escape hatch would make every future risk assessment moot.
- Not NIP-17 DM *receiving* — still out of scope, same reasons as the channel adapter (gift-wrap complexity, unverified interop). DM *sending* is in scope (see Tool surface) since it's much simpler one-way.

## Architecture

### The credential boundary is the whole design constraint

`BUZZ_NSEC` lives in the host's `.env`, read via `readEnvFile()`, and must never enter a container (same rule as every other native-adapter credential — see `docs/architecture.md`'s "Skills don't patch config.ts" convention and the container security notes in `CLAUDE.md`). Any Buzz action beyond what the channel adapter's `deliver()` already does — i.e., anything that needs to sign a *new* kind of Nostr event — has to round-trip through the host.

NanoClaw already has exactly this shape, reused across `ncl`, self-mod (`install_packages`/`add_mcp_server`), and `create_agent`: a container-side MCP tool writes a `kind: 'system'` row to `outbound.db`, `src/delivery.ts`'s system-action dispatch picks it up, the action passes through `guard()` (`src/guard/`), and on `allow` a host-side handler does the privileged work and notifies the agent. **New Buzz tools should use this exact mechanism** (`registerDeliveryAction` + `defineGuardedAction`), not a bespoke path. `src/modules/buzz-actions/` (built as the PoC — see below) is the seam future tools attach to.

### Fire-and-forget vs. blocking

Two established patterns in this codebase:
- **Fire-and-forget** (self-mod, `create_agent`): tool returns immediately, host processes later (possibly after human approval, unbounded latency), result surfaces as a new chat message.
- **Blocking write-then-poll** (`ask_user_question`, the `ncl` CLI): tool call blocks inside the handler, polling `inbound.db` for a response keyed by `requestId`, bounded by a timeout.

The PoC (`buzz_set_profile`) uses fire-and-forget — simplest, matches its own guard decision (never holds, so there's no "wait for a human to click" scenario, but the publish itself is still an async host round trip and self-mod's shape already handles that cleanly). Tools that complete fast and deterministically (no human in the loop, ever) are candidates for the blocking pattern instead, for a more synchronous-feeling UX — but that requires either a new generic `findResponseByRequestId()` helper next to `findQuestionResponse()` in `container/agent-runner/src/db/messages-in.ts`, or reusing `ask_user_question`'s exact mechanism, which is presently coupled to its `ask_question` chat-card type. Worth building once more than one tool wants it — premature for a single-tool PoC.

### Guard decisions per tool, not one blanket policy

Each tool gets its own `defineGuardedAction` entry (`src/modules/buzz-actions/guard.ts`) with a `decide()` suited to its actual risk:
- Low-risk, self-scoped, easily reversible (profile text, reactions) → `ALLOW` for any agent actor.
- Anything that posts content a human other than the operator will see as coming "from" the identity in a context the agent doesn't already have standing in (DM to an arbitrary pubkey, admin channel actions) → `HOLD`, following `agents.create`'s cli_scope-conditional pattern or `a2a.send`'s per-pair-policy pattern as precedent for "sometimes allow, sometimes hold."
- Never share one guard entry across tools with different risk profiles — `buzzSetProfile`'s `ALLOW` must not accidentally cover a future higher-stakes tool just because it's convenient to reuse.

### Connection model

The channel adapter (`buzz.ts`) holds one long-lived `Relay` connection for the life of the process (needed for its polling loop). Host-side action handlers (`src/modules/buzz-actions/apply.ts`) open a short-lived connection per call instead of sharing that one — simpler, no contention, and today's expected call volume (profile updates, occasional reactions) doesn't justify the complexity of sharing a connection across two independently-lifecycled modules. **Revisit if a high-frequency tool (e.g. a reaction-on-every-message tool) gets built** — at that point a shared connection or a small connection pool starts to matter for relay-side connection churn.

### Inbound delivery is polled, not pushed (context for anything read-oriented)

Confirmed via live testing against buzz-trial: the relay does not push live events to an open subscription — it answers a REQ with a stored-event snapshot + EOSE and nothing more, filter shape notwithstanding. The channel adapter already works around this with a poll loop (`INBOUND_POLL_MS`, `src/channels/buzz.ts`). **Any future tool that needs to read something back** (e.g. `buzz_search`, or confirming a reaction landed) needs to either poll the same way or do a synchronous one-shot `collectOnce`-style REQ — never assume a subscription will hand you something later.

## Tool surface (target, phased)

| Tool | NIP / kind | Guard | Pattern | Notes |
|---|---|---|---|---|
| `buzz_set_profile` | kind:0 | ALLOW (agent) | fire-and-forget | **Built (PoC)** |
| `buzz_react` | NIP-25, kind:7 | ALLOW (agent) | fire-and-forget | Needs a target event id — agent has to have seen the message via the channel adapter first |
| `buzz_search` | NIP-50 | ALLOW (agent) | blocking (worth the generic response-poll helper) | Read-only, low risk, but round-tripping a search result back synchronously is the actual point of the tool |
| `buzz_send_dm` | NIP-17, kind:1059 | HOLD (default) or ALLOW-with-allowlist | fire-and-forget | Simpler than *receiving* DMs (one gift-wrap, no subscription), but sending unsolicited content to an arbitrary pubkey the agent doesn't already have standing with is exactly the kind of action that should default to held |
| `buzz_delete_message` | NIP-09, kind:5 | ALLOW (self-authored only — protocol already restricts to your own events) | fire-and-forget | |
| `buzz_join_channel` / `buzz_leave_channel` | kind:9021/9022 | ALLOW (agent) for open channels; N/A for closed (needs admin, see below) | fire-and-forget | Open-channel self-join only; closed channels need an admin `kind:9000` regardless of this tool |
| `buzz_admin_add_member` | NIP-43-ish, kind:9000/9030 | HOLD | fire-and-forget, notify on completion | This is the "SSH + `buzz-admin`" workflow Mycroft already does manually — the highest-value tool after profile-set, but explicitly gated since it changes another identity's access |
| git/workflow (NIP-34, `buzz-workflow` triggers) | — | — | — | Out of scope for this spec entirely; different enough (git object model, YAML workflow definitions) to warrant its own design pass if it's ever wanted, not an incremental addition to this tool set |

Priority order if picking up more of this: `buzz_react` (cheapest, most obviously useful) → `buzz_admin_add_member` (directly replaces the manual SSH workflow) → `buzz_search` (needs the blocking-poll infrastructure first) → `buzz_send_dm` (needs a real answer on the HOLD-vs-allowlist question below).

## Open questions

1. **`buzz_send_dm`'s default guard tier** — HOLD-every-time is safe but may be too much friction if e.g. Jeff wants agents to freely DM him. An allowlist of pubkeys per agent group (mirroring `agent_message_policies`' per-pair-approver model) is a reasonable middle ground — not built, needs a decision before this tool ships.
2. **Should `buzz_admin_add_member` require the actor to already be an admin of the target channel**, or is workspace-level trust (whatever gates the NanoClaw agent's own Buzz membership today) sufficient? Affects whether `decide()` needs a live NIP-29 admin-list check (kind:39001) before allowing/holding.
3. **The generic blocking-response helper** (`findResponseByRequestId` in `container/agent-runner/src/db/messages-in.ts`) doesn't exist yet — needed for `buzz_search` and any other read-oriented tool. Small, mechanical addition once a second consumer justifies it.
4. **Relay reconnect during a short-lived apply.ts connection** — `apply.ts` doesn't set `enableReconnect: true` (a one-shot connect/publish/close doesn't need it), but if a call happens to land during a relay outage, today's behavior is just "the call fails, agent gets notified." No retry. Acceptable for a low-frequency action; revisit if failure-rate data says otherwise.
5. **Does `buzz_admin_add_member` actually map onto `buzz-admin add-member` (workspace-wide) or the NIP-29 kind:9000 (channel-scoped)?** Live testing found `buzz-admin`'s CLI only does workspace-level roster membership, not per-channel — a real gap discovered building the channel adapter (see its SKILL.md's Wiring section). Whichever this tool targets needs to be built against the *actual* mechanism, not assumed from Buzz's docs — same lesson as the channel adapter's mention-detection and live-push assumptions, both of which turned out wrong on contact with the real relay.

## What the PoC proves

`buzz_set_profile`, built end-to-end on `feat/buzz-adapter`:
- Container: `container/agent-runner/src/mcp-tools/buzz.ts` — new MCP tool, fire-and-forget, mirrors `self-mod.ts`/`agents.ts` exactly.
- Host: `src/modules/buzz-actions/{guard.ts,apply.ts,index.ts}` — new guarded delivery action, reuses `BUZZ_NSEC` the same way the channel adapter does, signs and publishes a kind:0 event on a short-lived connection.
- Wired into `src/modules/index.ts` (host) and `container/agent-runner/src/mcp-tools/index.ts` (container).
- Host side: typechecks clean, `pnpm test` and `guard/conformance.test.ts` pass.
- Container side: **not typechecked** — this host has no `bun` installed, and container typecheck requires it (`Cannot find type definition file for 'bun'` — a known, documented limitation, see `CLAUDE.md`'s Container Build Cache / `update-nanoclaw`'s diagnostics section). The file was written by close structural mirroring of `self-mod.ts` (already-compiling, same imports/types/shapes) rather than verified by the compiler. **Needs a real typecheck and a live test (post a request, confirm the profile actually changes on buzz-trial) before this ships past PoC** — not done here since Jeff was away from Buzz/mobile when this was built.
- No container-side test written (`container/agent-runner/src/mcp-tools/*.test.ts` pattern exists for other tools — `buzz.ts` doesn't have one yet).

## A consequence worth flagging explicitly, not discovering late

`container/agent-runner/src/mcp-tools/index.ts` starts one unconditional MCP server per container — `buzz_set_profile` (like `install_packages`, `create_agent`, etc.) is available to **every** agent group once the image is rebuilt, not just ones wired to a Buzz channel. Since there's currently one shared Buzz identity across all four agent groups (`main`, `telegram_infra`, `telegram_fitness`, `telegram_realestate` all wired to the same `general` channel under the same nsec), any of them calling `buzz_set_profile` changes the *same* shared profile — consistent with the fact they already all post into `general` as the same identity, not a new privilege boundary, but worth being deliberate about rather than surprised by. If Buzz identity ever stops being 1:1 shared across agent groups, this tool's guard (or its own scoping logic) needs to catch up — `decide()` currently doesn't check which agent group is calling at all.

## Verification still needed (blocked on Jeff having Buzz access again)

1. `cd container/agent-runner && bun install && bun run typecheck` (or wherever the container typecheck command actually lives — confirm against `container/agent-runner/package.json`).
2. `./container/build.sh` to rebuild the agent image with the new MCP tool.
3. Wire `buzz_set_profile` into an agent group's `container_configs.mcpServers` (or confirm it's picked up automatically if MCP tools in the barrel are always available — check `container-config.ts`/`claude-md-compose.ts` for whether built-in tools need explicit per-group enablement or are unconditional).
4. Restart, have an agent call `buzz_set_profile`, confirm via `buzz-admin`/the relay that the kind:0 event actually landed and Buzz clients render the new name/about.
5. Confirm the failure paths (missing `BUZZ_NSEC`, relay unreachable) produce the expected `notifyAgent` message rather than a silent drop or an unhandled rejection.
