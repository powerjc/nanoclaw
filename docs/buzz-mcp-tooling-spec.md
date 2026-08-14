# Buzz identity tooling — spec + PoC

## Context

`src/channels/buzz.ts` (see `.claude/skills/add-buzz/`) gives NanoClaw agents a presence in Buzz's NIP-29 text channels — read/post plain messages, nothing else. That's deliberate MVP scope, but it means NanoClaw agents can't do anything Buzz-native beyond chatting: no profile customization, no reactions, no search, no DMs, no channel administration, no git/workflow integration. Jeff's own infra agent (Mycroft) already hit this wall once and had to SSH into buzz-trial and run `buzz-admin`/`buzz` CLI by hand to set its own profile.

Hermes runs Buzz's own agent stack (`buzz-acp`, `buzz-dev-mcp`, `buzz-workflow`) and gets all of this natively, at the cost of sitting outside NanoClaw's session/memory/approval model entirely (the tradeoff discussed and deliberately rejected when the channel adapter was built). This spec is the other way to close the gap: give NanoClaw agents purpose-built commands for the Buzz features they're missing, without giving up NanoClaw's session/memory/approval model.

## Revision note

The first version of this spec and its PoC built each Buzz action as an MCP tool + hand-written `defineGuardedAction`/`registerDeliveryAction` pair (mirroring self-mod). An Opus review of that draft (see git history on `feat/buzz-adapter`) found it real but flawed: the guard was decorative (a constant `ALLOW` dressed as a guard, `requestHold` unreachable and satisfied by a stub), the packaging put Buzz-only code in `src/modules/` unconditionally even though the channel itself is skill-installed (so the skill's own `REMOVE.md` would break the host build), and — separately from either of those — the PoC had a real correctness bug (kind:0 profile events are *replaceable*; a partial update erased whatever wasn't passed). The review also pointed out that `ncl` already has per-verb approval tiering, a working blocking request/response transport, and a `cli_scope` off-switch — everything the guarded-delivery-action pattern would otherwise require hand-building per tool.

This revision moves the PoC to an `ncl buzz` CLI resource (`src/cli/resources/buzz.ts`, `.claude/skills/add-buzz/resources/cli-buzz.ts`) and fixes the correctness bug. See "What the PoC proves" below for exactly what changed.

## Non-goals

- Not re-litigating native adapter vs. `buzz-acp` sidecar — settled, channel adapter stands.
- Not a generic "publish arbitrary raw Nostr event" verb. Each capability gets its own purpose-built verb with its own access tier — a raw-publish escape hatch would make every future risk assessment moot.
- Not NIP-17 DM *receiving* — still out of scope, same reasons as the channel adapter (gift-wrap complexity, unverified interop). DM *sending* is in scope (see Tool surface) since it's much simpler one-way.

## Architecture

### The credential boundary is the whole design constraint

`BUZZ_NSEC` lives in the host's `.env`, read via `readEnvFile()`, and must never enter a container (same rule as every other native-adapter credential). Any Buzz action beyond what the channel adapter's `deliver()` already does — i.e., anything that needs to sign a *new* kind of Nostr event — has to run host-side.

### `ncl` resource, not a hand-built guarded delivery action

Each verb lives in `src/cli/resources/buzz.ts` as a `customOperations` entry (`registerResource`, same shape as `src/cli/resources/roles.ts`'s `grant`/`revoke`). `access: 'open' | 'approval'` on the verb is the entire access decision — no per-verb `defineGuardedAction`/`registerDeliveryAction`/`registerApprovalHandler` triple to hand-write; the generic `cli_command` guard and approval handler (already registered once, used by every `ncl` command) do that work. `GROUP_SCOPE_RESOURCES` in `src/cli/registry.ts` gates whether `cli_scope: 'group'` agents (the default for non-owner agent groups) can reach the resource at all — `'buzz'` is in that set.

**Real limitation found while building this**: `access: 'approval'` is *unconditional* hold — there's no way to express "hold only for non-global `cli_scope`" (the `agents.create` pattern) purely through `CommandDef.access`. A verb that needs conditional gating has to step outside the `registerResource` framework into a hand-written `defineGuardedAction`, same as `agents.create`/`a2a.send` already do. None of the verbs planned so far need that — `set-profile` is flat `open`, and anything that should always hold (see Tool surface) is flat `approval` — but it's worth knowing before assuming every future verb fits this pattern.

**Per-caller wiring check, done in the handler, not the framework**: `requireBuzzWiring()` denies an agent caller whose agent group has no Buzz channel wired (`getMessagingGroupsByAgentGroup(agentGroupId).some(mg => mg.channel_type === 'buzz')`). This exists because `ncl buzz` is globally registered — every agent group's container can reach it once installed, not just ones with a real Buzz relationship (see "A consequence worth flagging" below) — and the framework's `access` field can't express "allowed, but only for callers who satisfy X."

### Blocking, not fire-and-forget

`ncl`'s container-side transport (`container/agent-runner/src/cli/ncl.ts`) is a write-request-then-poll-for-response round trip through the two session DBs, bounded by a 30s timeout — the agent's `ncl buzz set-profile ...` call blocks and returns the real result (success payload or error message) directly, no "you'll be notified" follow-up message needed. This is simpler UX than the fire-and-forget MCP-tool shape the first draft used, and it's free — the transport already existed for every other `ncl` command.

### Read-modify-write for replaceable events

`kind:0` (profile) is a Nostr *replaceable* event — a relay keeps only the newest one per `(pubkey, kind)`, and clients read the whole profile from its JSON. `set-profile` fetches the current profile (`collectOnce({kinds:[0], authors:[pubkey], limit:1})`), merges the passed fields on top, and publishes the merged result — never a raw overwrite. Any future verb that touches a replaceable or otherwise stateful kind needs to apply the same read-modify-write discipline; it's not specific to profiles.

### Verify, don't assume

`set-profile` reads back the just-published event by id before reporting success (`collectOnce({ids:[event.id]})`). This relay has already been found to diverge from documented/expected Nostr behavior twice (p-tag mentions not used for @-mentions; no live push to open subscriptions) — trusting `relay.publish()` resolving as proof the event is visible isn't safe here specifically.

### Connection model

The channel adapter (`buzz.ts`) holds one long-lived `Relay` connection for its polling loop. `ncl buzz` verbs open a short-lived connection per call instead — simpler, no contention with the adapter's own connection, and today's expected call volume doesn't justify sharing. Revisit if a high-frequency verb (e.g. react-on-every-message) gets built.

## Tool surface (target, phased)

| Verb | NIP / kind | Access | Notes |
|---|---|---|---|
| `buzz set-profile` | kind:0 | `open` (wiring-checked) | **Built (PoC).** Read-modify-write, verified publish. |
| `buzz react` | NIP-25, kind:7 | `open` (wiring-checked) | Needs a target event id — agent has to have seen the message via the channel adapter first |
| `buzz search` | NIP-50 | `open` (wiring-checked) | Read-only, but results are untrusted content re-entering agent context from a channel the agent doesn't control — treat like any other externally-sourced text, not free of risk just because it's read-only |
| `buzz send-dm` | NIP-17, kind:1059 | `approval` | Sending unsolicited content to an arbitrary pubkey the agent doesn't have standing with is exactly what approval-gating is for. **The `pending_approvals` row is deleted on resolution (`src/modules/approvals/primitive.ts`)** — for a DM, that row is also the only record of what was sent, since the operator can't read a gift-wrapped message after the fact. Needs a durable audit copy (e.g. logged separately before the row is deleted) before this ships, not just the approval gate. |
| `buzz delete-message` | NIP-09, kind:5 | `approval`, bound to the calling session's own published events | NOT `open`-any-own-event: "your own" means the *shared identity's* events — any agent group can delete any other agent group's messages under today's one-identity model, since NIP-09 deletion is advisory (relay discretion) rather than protocol-enforced, and nothing here scopes it to the calling session. Restrict to event ids the calling session actually published (`delivered.platform_message_id`, written by `src/delivery.ts`) before allowing even with approval. |
| `buzz join-channel` | kind:9021 | `approval` | Creates new inbound traffic from senders no one has admitted yet — interacts with `unknown_sender_policy` and the dropped-messages path. Not self-scoped enough for `open`. |
| `buzz leave-channel` | kind:9022 | **not planned as agent-callable** | Membership is a property of the shared identity, not the calling agent group — one agent leaving deprovisions Buzz presence for *every* agent group wired to that channel, and `src/channels/buzz.ts` computes `memberGroupIds` once at `setup()` and never refreshes, so the adapter keeps silently polling a channel it's no longer in until a restart. Closed-channel re-join needs an admin regardless. If this needs to exist at all, it's an operator-only `ncl` verb (`hostOnly: true`), not agent-reachable. |
| `buzz admin-add-member` | workspace-wide via `buzz-admin`, NOT per-channel (confirmed live — Buzz's CLI has no channel-scoped membership verb; per-channel needs a raw NIP-29 `kind:9000` signed by a channel admin, which the shared identity may not be) | `approval` | Replaces the manual SSH + `buzz-admin` workflow. Needs open question #2 (below) resolved before building — which mechanism it actually targets changes the implementation, not just the guard tier. |
| git/workflow (NIP-34, `buzz-workflow` triggers) | — | — | Out of scope entirely — different enough (git object model, YAML workflow definitions) to warrant its own design pass, not an incremental addition here. |

Every verb above should be reviewed for prompt-injection exposure before shipping, not just data-loss/destructiveness risk: every one of them is called by an agent whose context is filled with messages other humans and agents wrote in the same shared channel the verb acts on. `agents.create`'s guard names this explicitly as its reason to hold ("the realistic prompt-injection victim") — the same reasoning applies here, and it's part of why `set-profile` stays `open` (worst case of an injected rename is social-engineering-shaped, not data-destructive or credential-exposing) while `send-dm`/`delete-message`/`join-channel` don't.

Priority order if picking up more of this: `buzz react` (cheapest, most obviously useful, same risk tier as the one already built) → `buzz admin-add-member` (directly replaces the manual SSH workflow, but blocked on open question #2) → `buzz search` → `buzz send-dm` (blocked on the audit-record question).

## Open questions

1. **`buzz send-dm`'s audit trail** — `pending_approvals` rows are deleted on resolution, so approval alone doesn't leave a record of what was actually sent. Needs a durable log (even a plain file) written before the row is deleted, independent of the tier decision.
2. **What does `buzz admin-add-member` actually call?** Confirmed live: `buzz-admin add-member` is workspace-wide roster membership (`kind:13534`), not per-channel. Per-channel membership is a raw NIP-29 `kind:9000`, admin-signed — and the shared NanoClaw identity may not itself be a channel admin, in which case this verb can't self-serve at all and the workflow stays manual. Check admin status (`kind:39001`) before designing the verb, not after.
3. **Multi-instance identity.** `src/channels/buzz.ts` and `ncl buzz` both assume one global `BUZZ_NSEC`. If a second Buzz adapter instance is ever added with a different key (mirroring how other channels support multiple instances), every `ncl buzz` verb silently signs as the wrong identity — nothing here has an instance concept. Not urgent (no second instance exists), but should block adding one until this is addressed.
4. **Rate limiting / loop risk.** Nothing caps how often an agent can call `buzz set-profile` (or any future verb) in one session. Low risk today (blocking call, no auto-wake-on-completion the way the old MCP-tool draft had), but worth a second look once verbs with side effects visible to other agents (react, DM) exist.
5. **Concurrent writers to the shared kind:0.** Four agent groups, one identity, one profile — read-modify-write narrows the race window `set-profile` had before (blind overwrite) but doesn't eliminate it: two concurrent calls can still interleave read/publish and one's changes can be lost. Not fixed; acceptable at today's call volume, revisit if it becomes a real footgun.
6. **Why does `BUZZ_NSEC` sit in plaintext `.env` instead of the OneCLI vault?** The project's stated doctrine is that credentials live in OneCLI; this one doesn't. Working assumption: OneCLI's request-time HTTP-proxy model doesn't cover raw signing keys (it injects bearer tokens into outbound HTTP calls, not arbitrary cryptographic material), so `.env` is the correct fallback, same as it is for the channel adapter itself — but this should be confirmed against OneCLI's actual capabilities rather than assumed, and stated explicitly rather than left for a reader to wonder about.

## What the PoC proves

`buzz set-profile`, built end-to-end on `feat/buzz-adapter`:

- `src/cli/resources/buzz.ts` — `ncl buzz set-profile`, `access: 'open'`, wiring-checked (`requireBuzzWiring`), read-modify-write, verified publish, field-length caps, `https://`-only picture URL validation.
- Packaging fixed: lives in `.claude/skills/add-buzz/resources/cli-buzz.ts` (installed to `src/cli/resources/buzz.ts`), not core — the skill's `REMOVE.md` now reverses it correctly alongside the channel adapter and shared `nostr-tools`/`ws` deps.
- Wired into `src/cli/resources/index.ts`, `GROUP_SCOPE_RESOURCES` (`src/cli/registry.ts`), and the two agent-facing docs (`container/agent-runner/src/mcp-tools/cli.instructions.md`, root `CLAUDE.md`).
- The earlier MCP-tool + `src/modules/buzz-actions/` draft was deleted entirely, not kept alongside this.
- Host side: typechecks clean, full `pnpm test` suite and `guard/conformance.test.ts` pass (this resource doesn't add a guard-catalog entry at all — `access: 'open'`/`'approval'` route through the pre-existing generic `cli_command` guard, so there's nothing new for conformance to check).
- **No dedicated test for the new resource** — covered only structurally (typecheck, and `nostr-tools`/`ws` import-throws-if-missing the same way the channel adapter's registration test covers its own deps). Nothing asserts `set-profile`'s read-modify-write or verification logic actually work. This is the main remaining gap.

## A consequence worth flagging explicitly, not discovering late

`ncl buzz` is globally registered once installed — every agent group's container can run it, not just ones wired to a Buzz channel. `requireBuzzWiring()` (in the `set-profile` handler) denies agent callers whose agent group has no Buzz channel wired, so a group with no Buzz relationship gets a clear error rather than silently succeeding or silently failing. Since there's currently one shared Buzz identity across all four agent groups wired to `general`, any of them calling `set-profile` changes the *same* shared profile — consistent with them already all posting into `general` as the same identity, not a new privilege boundary, but still worth being deliberate about. If Buzz identity ever stops being 1:1 shared, `requireBuzzWiring` needs to narrow further (e.g. check the caller's specific wired channel matches the identity being modified), and open question #3 (multi-instance) becomes urgent.

## Verification (now that Jeff has Buzz access)

1. `pnpm exec tsc --noEmit` (host) — already clean; container side has no bun on this host, run via the Docker bun image if a full container typecheck matters (`docker run --rm -v "$PWD":/src -w /src/container/agent-runner oven/bun:1.3.12 sh -c 'bun install --frozen-lockfile && bunx tsc -p tsconfig.json --noEmit'` — same image CI uses) — not blocking for this PoC since `ncl buzz` is host-only code, no container-side file changed.
2. Restart the service so `src/cli/resources/buzz.ts` is loaded.
3. `ncl buzz set-profile --name "<test>"` from a wired agent group (or the host CLI) — confirm it returns the merged profile and an event id.
4. Confirm on the relay / in a Buzz client that the identity's name changed and any previously-set `about`/`picture` are still intact (the read-modify-write check).
5. Call it from an agent group with no Buzz channel wired — confirm the "no Buzz channel wired" error, not a silent success.
6. Missing/invalid `BUZZ_NSEC` and relay-unreachable paths — confirm they produce a clear `ncl` error, not an unhandled rejection or a hang past the 30s transport timeout.
