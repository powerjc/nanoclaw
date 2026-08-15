/**
 * Buzz (Nostr) identity actions — `ncl buzz <verb>`.
 *
 * Not a DB-backed resource (no `operations`, no generic list/get) — every
 * verb here signs and publishes to the Buzz relay using a host-only
 * BUZZ_NSEC_<INSTANCE> identity, same multi-instance model as
 * src/channels/buzz.ts (one Nostr keypair per persona, not one shared
 * identity for the whole install — see that file's header comment). The
 * container never receives any of these keys; this handler runs host-side,
 * same as every other `ncl` verb, reached via the normal container DB
 * transport (container/agent-runner/src/cli/ncl.ts) with no special-casing
 * needed there.
 *
 * access: 'open' — any caller who reaches this resource (see the
 * GROUP_SCOPE_RESOURCES entry in ../registry.ts) can call set-profile
 * without admin approval. It's self-scoped (a persona's own display
 * name/about/picture) and reversible. `resolveInstance` below both picks
 * which identity a call targets AND enforces that an agent caller can only
 * ever target an instance its own agent group is actually wired to — it
 * can't reach for another persona's Buzz identity by guessing an
 * `--instance` value. A future, more sensitive Buzz verb (e.g. anything
 * that posts to a channel/DM outside the caller's own wiring) should use
 * `access: 'approval'` rather than extending this one's `open` access.
 */
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import WebSocket from 'ws';

import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { readEnvFile } from '../../env.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

// See src/channels/buzz.ts for the fuller explanation — Node's global
// WebSocket isn't stable until Node 22, host is only guaranteed >=20.
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

const AUTH_TIMEOUT_MS = 10_000;
const AUTH_POLL_MS = 150;
const MAX_FIELD_LENGTH = 512;
// Profile pictures are fetched by other people's Buzz clients — https only,
// no loopback exception (unlike MCP server URLs elsewhere in this codebase,
// there's no legitimate localhost use case for a profile avatar).
const PICTURE_URL_RE = /^https:\/\//;

interface BuzzIdentity {
  relayUrl: string;
  secretKey: Uint8Array;
}

async function loadIdentity(instance: string): Promise<BuzzIdentity | null> {
  const nsecKey = `BUZZ_NSEC_${instance.toUpperCase()}`;
  const env = readEnvFile(['BUZZ_RELAY_URL', nsecKey]);
  const relayUrl = process.env.BUZZ_RELAY_URL || env.BUZZ_RELAY_URL || '';
  const nsec = process.env[nsecKey] || env[nsecKey] || '';
  if (!relayUrl || !nsec) return null;
  try {
    const decoded = nip19Decode(nsec);
    if (decoded.type !== 'nsec') return null;
    return { relayUrl, secretKey: decoded.data };
  } catch {
    return null;
  }
}

/**
 * Which Buzz identity this call targets, and the authorization check that
 * goes with it. An explicit `--instance` is honored only for host callers
 * (the operator, via the CLI socket — no agent group to scope to). An agent
 * caller's instance is always derived from its own wiring, never trusted
 * from `--instance` — an agent group wired to `buzz-fitness` cannot pass
 * `--instance realestate` and reach a different persona's identity.
 *
 * CONFIRMED FOOTGUN, fixed here: an earlier version silently discarded
 * `--instance` for agent callers instead of rejecting a mismatch — an agent
 * passing `--instance main` got no error, just its own wired identity back,
 * with zero signal anything was off. Live-tested consequence: three
 * in-agent calls each silently redirected to the infra identity and
 * overwrote its profile three times in a row, while main/fitness/realestate
 * silently never got touched. Passing `--instance` as an agent is now only
 * valid when it names the caller's own resolved instance (redundant but
 * harmless); anything else is a hard error, never a silent redirect.
 *
 * Denies outright if the calling agent group has no Buzz channel wired at
 * all, or is wired to more than one Buzz instance (ambiguous — not expected
 * under today's one-instance-per-agent-group design, fails closed rather
 * than guessing).
 */
export function resolveInstance(args: Record<string, unknown>, ctx: CallerContext): string {
  const explicit = args.instance as string | undefined;

  if (ctx.caller === 'host') {
    if (!explicit) {
      throw new Error(
        '--instance is required when calling ncl buzz from the host (no agent group context to infer it from)',
      );
    }
    return explicit;
  }

  const buzzGroups = getMessagingGroupsByAgentGroup(ctx.agentGroupId).filter((mg) => mg.channel_type === 'buzz');
  if (buzzGroups.length === 0) {
    throw new Error(
      'this agent group has no Buzz channel wired — buzz commands are only available to agents connected to Buzz',
    );
  }
  const instances = new Set(buzzGroups.map((mg) => (mg.instance ?? 'buzz-').replace(/^buzz-/, '')));
  if (instances.size > 1) {
    throw new Error(
      `this agent group is wired to multiple Buzz identities (${[...instances].join(', ')}) — this shouldn't happen under the current one-instance-per-agent-group design; check the wiring`,
    );
  }
  const own = [...instances][0];
  if (explicit !== undefined && explicit !== own) {
    throw new Error(
      `this agent group's Buzz identity is "${own}" — you cannot target another persona's identity ("${explicit}") from here. Omit --instance or pass --instance ${own}.`,
    );
  }
  return own;
}

/** Bounded retry against the "no challenge was received yet" race — see
 *  src/channels/buzz.ts's waitForAuth, same logic, duplicated because this
 *  is a one-shot CLI call with no shared Relay instance to hang a method off. */
async function waitForAuth(relay: Relay, secretKey: Uint8Array): Promise<void> {
  const signAuthEvent = async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, secretKey);
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  for (;;) {
    try {
      await relay.auth(signAuthEvent);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no challenge was received') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
        continue;
      }
      throw new Error(`Buzz relay authentication failed: ${message}`);
    }
  }
}

/** One-shot subscribe/collect/EOSE-close — the relay doesn't push live
 *  events to open subscriptions (see src/channels/buzz.ts's header comment
 *  for how that was confirmed), so every read here is this shape. */
function collectOnce(relay: Relay, filter: Parameters<Relay['subscribe']>[0][number]): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const timeout = setTimeout(() => {
      sub.close();
      reject(new Error('Buzz relay query timed out'));
    }, AUTH_TIMEOUT_MS);
    const sub = relay.subscribe([filter], {
      onevent(event) {
        events.push(event);
      },
      oneose() {
        clearTimeout(timeout);
        sub.close();
        resolve(events);
      },
    });
  });
}

registerResource({
  name: 'buzz-identity',
  plural: 'buzz',
  table: '', // not DB-backed — no generic operations are registered below
  description: "Buzz (Nostr) identity actions — one identity per persona, see 'ncl buzz help' for verbs.",
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    'set-profile': {
      access: 'open',
      description:
        "Update this identity's Buzz profile (display name / about / avatar). Reads the current profile first and merges — does not erase fields you don't pass. Agent callers always target their own wired identity — --instance is required for host/operator calls, and for agent callers is only valid if it matches their own identity (anything else is a hard error, never a silent redirect to the wrong one).",
      args: [
        { name: 'name', type: 'string', description: 'Display name' },
        { name: 'about', type: 'string', description: 'Bio / about text' },
        { name: 'picture', type: 'string', description: 'Avatar image URL (https:// only)' },
        {
          name: 'instance',
          type: 'string',
          description:
            'Which Buzz identity. Required for host/operator calls. For agent callers: omit it, or pass it matching your own wired identity — passing a different one errors rather than silently targeting your own.',
        },
      ],
      examples: [
        'ncl buzz set-profile --name "Mycroft" --about "Infra & ops. Old graybeard sysadmin."',
        'ncl buzz set-profile --instance fitness --name "Hans"  # host-only, explicit instance',
      ],
      handler: async (args, ctx) => {
        const instance = resolveInstance(args, ctx);

        const name = args.name as string | undefined;
        const about = args.about as string | undefined;
        const picture = args.picture as string | undefined;
        if (name === undefined && about === undefined && picture === undefined) {
          throw new Error('provide at least one of --name, --about, --picture');
        }
        for (const [flag, value] of [
          ['name', name],
          ['about', about],
          ['picture', picture],
        ] as const) {
          if (value !== undefined && value.length > MAX_FIELD_LENGTH) {
            throw new Error(`--${flag} exceeds ${MAX_FIELD_LENGTH} characters`);
          }
        }
        if (picture !== undefined && !PICTURE_URL_RE.test(picture)) {
          throw new Error('--picture must be an https:// URL');
        }

        const identity = await loadIdentity(instance);
        if (!identity)
          throw new Error(`BUZZ_RELAY_URL/BUZZ_NSEC_${instance.toUpperCase()} not configured on this host`);
        const pubkey = getPublicKey(identity.secretKey);

        const relay = await Relay.connect(identity.relayUrl, {});
        try {
          relay.onauth = async (t) => finalizeEvent(t, identity.secretKey);
          await waitForAuth(relay, identity.secretKey);

          // kind:0 is a replaceable event — a naive publish of only the
          // fields the caller passed would erase every other field the
          // current profile has (about, picture, nip05, etc.). Fetch what's
          // there now and merge instead.
          const existing = await collectOnce(relay, { kinds: [0], authors: [pubkey], limit: 1 });
          let current: Record<string, unknown> = {};
          if (existing.length > 0) {
            try {
              current = JSON.parse(existing[0].content) as Record<string, unknown>;
            } catch {
              current = {};
            }
          }
          const merged = {
            ...current,
            ...(name !== undefined ? { name } : {}),
            ...(about !== undefined ? { about } : {}),
            ...(picture !== undefined ? { picture } : {}),
          };

          const event = finalizeEvent(
            { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(merged) },
            identity.secretKey,
          );
          await relay.publish(event);

          // Verify rather than assume — this relay has already been found to
          // diverge from documented/expected Nostr behavior twice (mention
          // tagging, live subscription push), so confirm the event actually
          // landed instead of trusting publish() resolving.
          const confirmed = await collectOnce(relay, { ids: [event.id] });
          if (confirmed.length === 0) {
            throw new Error('profile event published but could not be confirmed on the relay — it may not have landed');
          }

          return { instance, eventId: event.id, profile: merged };
        } finally {
          relay.close();
        }
      },
      formatHuman: (data) => {
        const { instance, eventId, profile } = data as {
          instance: string;
          eventId: string;
          profile: Record<string, unknown>;
        };
        return `Buzz[${instance}] profile updated (event ${String(eventId).slice(0, 12)}...): ${JSON.stringify(profile)}`;
      },
    },
  },
});
