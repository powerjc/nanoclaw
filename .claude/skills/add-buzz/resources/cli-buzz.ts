/**
 * Buzz (Nostr) identity actions — `ncl buzz <verb>`.
 *
 * Not a DB-backed resource (no `operations`, no generic list/get) — every
 * verb here signs and publishes to the Buzz relay using the host-only
 * BUZZ_NSEC identity src/channels/buzz.ts also uses. The container never
 * receives that key; this handler runs host-side, same as every other `ncl`
 * verb, reached via the normal container DB transport
 * (container/agent-runner/src/cli/ncl.ts) with no special-casing needed
 * there.
 *
 * access: 'open' — any caller who reaches this resource (see the
 * GROUP_SCOPE_RESOURCES entry in ../registry.ts) can call set-profile
 * without admin approval. It's self-scoped (the shared Buzz identity's own
 * display name/about/picture) and reversible. handler-level wiring check
 * below denies agent callers whose agent group has no Buzz channel wired at
 * all, so a group with no Buzz relationship can't reach this even though
 * it's globally registered — see docs/buzz-mcp-tooling-spec.md's
 * "unconditional availability" note for why that check matters given one
 * shared identity spans multiple agent groups today. A future, more
 * sensitive Buzz verb (e.g. anything that posts to a channel/DM outside
 * the caller's own wiring) should use `access: 'approval'` rather than
 * extending this one's `open` access.
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

async function loadIdentity(): Promise<BuzzIdentity | null> {
  const env = readEnvFile(['BUZZ_RELAY_URL', 'BUZZ_NSEC']);
  const relayUrl = process.env.BUZZ_RELAY_URL || env.BUZZ_RELAY_URL || '';
  const nsec = process.env.BUZZ_NSEC || env.BUZZ_NSEC || '';
  if (!relayUrl || !nsec) return null;
  try {
    const decoded = nip19Decode(nsec);
    if (decoded.type !== 'nsec') return null;
    return { relayUrl, secretKey: decoded.data };
  } catch {
    return null;
  }
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

function requireBuzzWiring(ctx: CallerContext): void {
  if (ctx.caller !== 'agent') return;
  const wired = getMessagingGroupsByAgentGroup(ctx.agentGroupId).some((mg) => mg.channel_type === 'buzz');
  if (!wired) {
    throw new Error('this agent group has no Buzz channel wired — buzz commands are only available to agents connected to Buzz');
  }
}

registerResource({
  name: 'buzz-identity',
  plural: 'buzz',
  table: '', // not DB-backed — no generic operations are registered below
  description: "Buzz (Nostr) identity actions for the shared BUZZ_NSEC identity — see 'ncl buzz help' for verbs.",
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    'set-profile': {
      access: 'open',
      description:
        "Update the shared Buzz identity's profile (display name / about / avatar). Reads the current profile first and merges — does not erase fields you don't pass.",
      args: [
        { name: 'name', type: 'string', description: 'Display name' },
        { name: 'about', type: 'string', description: 'Bio / about text' },
        { name: 'picture', type: 'string', description: 'Avatar image URL (https:// only)' },
      ],
      examples: ['ncl buzz set-profile --name "Mycroft" --about "Infra & ops. Old graybeard sysadmin."'],
      handler: async (args, ctx) => {
        requireBuzzWiring(ctx);

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

        const identity = await loadIdentity();
        if (!identity) throw new Error('BUZZ_RELAY_URL/BUZZ_NSEC not configured on this host');
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

          return { eventId: event.id, profile: merged };
        } finally {
          relay.close();
        }
      },
      formatHuman: (data) => {
        const { eventId, profile } = data as { eventId: string; profile: Record<string, unknown> };
        return `Buzz profile updated (event ${String(eventId).slice(0, 12)}...): ${JSON.stringify(profile)}`;
      },
    },
  },
});
