/**
 * Buzz channel adapter — NIP-29 group/channel messages over a Nostr relay.
 *
 * Bridges NanoClaw to Buzz (github.com/block/buzz), Block's Nostr-relay-based
 * agent/human workspace. Buzz channels are NIP-29 relay-groups: messages are
 * kind:9 events tagged `#h`=<channel-uuid>; membership/metadata are relay-signed
 * kind:39000/39002 events. Auth is NIP-42 challenge-response.
 *
 * MVP scope: channel/group messages only. NIP-17 encrypted DMs are a documented
 * fast-follow — no DM inbound/outbound path exists yet, and the `dm` block in
 * BUZZ_DEFAULTS below is declared only to satisfy ChannelDefaults' shape; it is
 * never reached because no DM inbound signal is ever emitted.
 *
 * Identity: reuses an existing Nostr keypair (operator-supplied nsec) that must
 * already be an invited member of whatever channels it should read/post to —
 * this adapter never generates a key or requests membership. supportsThreads:
 * false — NIP-29 channels are flat, one conversation per channel, like Signal/
 * Telegram/DeltaChat, not sub-threaded like Discord.
 *
 * Inbound delivery is polled, not a live subscription: confirmed by live
 * testing against a real Buzz relay that it answers a REQ with a one-time
 * snapshot (stored matches + EOSE) and never pushes anything to that
 * subscription afterward, `since` filter or not — a real relay-side limit,
 * not something fixable by changing the filter shape. So instead of one
 * persistent kind:9 subscription, the adapter re-issues a one-shot REQ with
 * `since: lastSeenTs` (inclusive — a per-second id set dedups the boundary,
 * since a strict lastSeenTs+1 can miss a message landing in the same second
 * the baseline was set) every POLL_INTERVAL_MS. Each connect skips backlog
 * (`lastSeenTs` starts at connect time) rather than replaying history — this
 * also sidesteps re-inserting already-processed messages into `messages_in`
 * on every restart, which previously collided on the id UNIQUE constraint.
 * Trade-off: messages sent while the process is down are not backfilled, and
 * live latency is bounded by POLL_INTERVAL_MS rather than instant.
 *
 * Required env vars (.env): BUZZ_RELAY_URL (e.g. ws://10.0.99.13:3000),
 *                           BUZZ_NSEC (bech32 nsec1... form)
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import { parseGroupMetadataEvent, parseGroupMembersEvent } from 'nostr-tools/nip29';
import WebSocket from 'ws';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

// nostr-tools/relay has no per-connection WebSocket option on the public Relay
// class — only this module-level hook. Node's global WebSocket isn't stable
// until Node 22; the host is only guaranteed >=20 (CI-pinned to 20), so this
// must always be set explicitly rather than relying on the global.
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

const AUTH_POLL_MS = 150;
const AUTH_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_MS = 5 * 60 * 1000;
const INBOUND_POLL_MS = 8_000;

interface BuzzEnv {
  relayUrl: string;
  secretKey: Uint8Array;
}

interface GroupInfo {
  id: string;
  name: string;
}

function platformIdFor(groupId: string): string {
  return `buzz:${groupId}`;
}

function groupIdFor(platformId: string): string {
  return platformId.startsWith('buzz:') ? platformId.slice('buzz:'.length) : platformId;
}

/** Tag a connectivity failure so channel-registry.ts's setup() retry (3x, [2s,5s,10s]) applies. */
function networkError(message: string, cause?: unknown): Error {
  const err = new Error(message, cause !== undefined ? { cause } : undefined);
  err.name = 'NetworkError';
  return err;
}

function createAdapter(env: BuzzEnv): ChannelAdapter {
  const pubkey = getPublicKey(env.secretKey);

  let relay: Relay | null = null;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let inboundPollTimer: ReturnType<typeof setInterval> | null = null;
  let memberGroupIds: string[] = [];
  let lastSeenTs = 0;
  // Event ids already delivered at exactly lastSeenTs — `since` is inclusive
  // of that second, so without this a message landing in the same second the
  // poll baseline advances would be redelivered on the next poll. Cleared
  // whenever lastSeenTs moves forward (older ids can never reappear once
  // `since` has advanced past their second).
  const seenAtLastSeenTs = new Set<string>();
  const groups = new Map<string, GroupInfo>(); // groupId -> metadata
  const memberLabels = new Map<string, Map<string, string>>(); // groupId -> pubkey -> label

  async function signAuthEvent(template: EventTemplate): Promise<VerifiedEvent> {
    return finalizeEvent(template, env.secretKey);
  }

  /**
   * relay.onauth (set below) reactively answers an AUTH challenge the moment
   * it arrives, but setup() still needs to know when that's actually done.
   * relay.auth() memoizes an in-flight/completed auth into one shared promise,
   * so calling it again here never double-signs — it just lets us await
   * completion (or catch the "no challenge received yet" race and retry).
   */
  async function waitForAuth(r: Relay): Promise<void> {
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    for (;;) {
      try {
        await r.auth(signAuthEvent);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('no challenge was received') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
          continue;
        }
        throw networkError('Buzz: relay authentication failed', err);
      }
    }
  }

  /** One-shot subscribe/collect/EOSE-close — used for discovery, membership, and inbound polling alike. */
  function collectOnce(r: Relay, filter: Parameters<Relay['subscribe']>[0][number]): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      const events: NostrEvent[] = [];
      const timeout = setTimeout(() => {
        sub.close();
        reject(new Error('Buzz: relay query timed out'));
      }, AUTH_TIMEOUT_MS);
      const sub = r.subscribe([filter], {
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

  async function discoverGroups(r: Relay): Promise<GroupInfo[]> {
    const events = await collectOnce(r, { kinds: [39000], limit: 100 });
    const discovered: GroupInfo[] = [];
    for (const event of events) {
      try {
        const metadata = parseGroupMetadataEvent(event);
        discovered.push({ id: metadata.id, name: metadata.name ?? metadata.id });
      } catch (err) {
        log.warn('Buzz: skipping malformed group metadata event', { eventId: event.id, err });
      }
    }
    return discovered;
  }

  /** Populates memberLabels[groupId]; returns whether our own pubkey is a member. */
  async function checkMembership(r: Relay, groupId: string): Promise<boolean> {
    const events = await collectOnce(r, { kinds: [39002], '#d': [groupId] });
    const labels = new Map<string, string>();
    for (const event of events) {
      try {
        for (const member of parseGroupMembersEvent(event)) {
          if (member.label) labels.set(member.pubkey, member.label);
          else labels.set(member.pubkey, member.pubkey);
        }
      } catch (err) {
        log.warn('Buzz: skipping malformed group members event', { groupId, eventId: event.id, err });
      }
    }
    memberLabels.set(groupId, labels);
    return labels.has(pubkey);
  }

  function handleInboundEvent(config: ChannelSetup, event: NostrEvent): void {
    // Nostr relays echo a publisher's own event back to their own matching
    // subscriptions — unlike Signal/DeltaChat there's no protocol-level
    // self-exclusion, so without this the agent would react to its own replies.
    if (event.pubkey === pubkey) return;

    const groupId = event.tags.find((t) => t[0] === 'h')?.[1];
    if (!groupId || !groups.has(groupId)) return;

    // Standard Nostr mention convention (a `p` tag naming our pubkey) — kept as
    // informational metadata on the message, but NOT declared reliable
    // (BUZZ_DEFAULTS.mentions = 'never'): confirmed against real Buzz clients
    // that "@mention" is literal text in `content`, not a `p` tag.
    const isMention = event.tags.some((t) => t[0] === 'p' && t[1] === pubkey) || undefined;
    const senderLabel = memberLabels.get(groupId)?.get(event.pubkey);

    config.onInbound(platformIdFor(groupId), null, {
      id: event.id,
      kind: 'chat',
      content: {
        text: event.content,
        sender: senderLabel ?? event.pubkey,
        senderId: `buzz:${event.pubkey}`,
      },
      timestamp: new Date(event.created_at * 1000).toISOString(),
      isGroup: true,
      isMention,
    });
  }

  /** Re-issues a one-shot REQ for anything at or after lastSeenTs (inclusive —
   *  see seenAtLastSeenTs above for why) — see the file-header comment for why
   *  this polls instead of using a persistent subscription. */
  async function pollInbound(config: ChannelSetup): Promise<void> {
    if (!relay?.connected || memberGroupIds.length === 0) return;
    let events: NostrEvent[];
    try {
      events = await collectOnce(relay, { kinds: [9], '#h': memberGroupIds, since: lastSeenTs });
    } catch (err) {
      log.warn('Buzz: inbound poll failed, will retry next interval', { err });
      return;
    }
    // Sort ascending — NIP-01 doesn't guarantee delivery order, and lastSeenTs
    // must advance monotonically for the same-second dedup logic below to hold.
    events.sort((a, b) => a.created_at - b.created_at);
    for (const event of events) {
      if (event.created_at < lastSeenTs) continue; // defensive; `since` should already exclude these
      if (event.created_at === lastSeenTs) {
        if (seenAtLastSeenTs.has(event.id)) continue;
        seenAtLastSeenTs.add(event.id);
      } else {
        lastSeenTs = event.created_at;
        seenAtLastSeenTs.clear();
        seenAtLastSeenTs.add(event.id);
      }
      handleInboundEvent(config, event);
    }
  }

  const adapter: ChannelAdapter = {
    name: 'buzz',
    channelType: 'buzz',
    supportsThreads: false,
    defaults: BUZZ_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      let r: Relay;
      try {
        r = await Relay.connect(env.relayUrl, { enableReconnect: true });
      } catch (err) {
        throw networkError(`Buzz: could not connect to relay ${env.relayUrl}`, err);
      }
      relay = r;

      // Reactive handler: answers every AUTH challenge, including on reconnect.
      r.onauth = signAuthEvent;
      r.onclose = () => {
        // enableReconnect means this only fires once the library has given up
        // reconnecting on its own — a real "something is wrong" signal, not
        // routine noise.
        log.warn('Buzz: relay connection closed', { relayUrl: env.relayUrl });
      };

      await waitForAuth(r);

      const discovered = await discoverGroups(r);
      memberGroupIds = [];
      for (const group of discovered) {
        const isMember = await checkMembership(r, group.id);
        if (!isMember) continue;
        groups.set(group.id, group);
        memberGroupIds.push(group.id);
        config.onMetadata(platformIdFor(group.id), group.name, true);
      }

      if (memberGroupIds.length === 0) {
        log.warn('Buzz: identity is not a member of any discovered group — connected but idle', {
          relayUrl: env.relayUrl,
          pubkey,
        });
      }

      // Skip backlog on connect (see file-header comment) — only poll for
      // messages from this point forward.
      lastSeenTs = Math.floor(Date.now() / 1000);
      inboundPollTimer = setInterval(() => {
        pollInbound(config).catch((err) => log.warn('Buzz: inbound poll threw unexpectedly', { err }));
      }, INBOUND_POLL_MS);

      // Defensive backstop for a known nostr-tools edge case: an error-flavored
      // (vs. clean-close) drop on the very first connection attempt can leave
      // reconnect permanently disabled for that connection (skipReconnection
      // latches true). Cheap insurance, not routine — only warns/kicks if the
      // relay is actually down.
      healthCheckTimer = setInterval(() => {
        if (relay && !relay.connected) {
          log.warn('Buzz: relay unexpectedly disconnected, attempting manual reconnect', { relayUrl: env.relayUrl });
          relay.connect({ timeout: 10_000 }).catch((err) => {
            log.error('Buzz: manual reconnect attempt failed', { err });
          });
        }
      }, HEALTH_CHECK_MS);

      log.info('Buzz: channel connected', { relayUrl: env.relayUrl, pubkey, groupCount: memberGroupIds.length });
    },

    async teardown(): Promise<void> {
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      if (inboundPollTimer) clearInterval(inboundPollTimer);
      relay?.close();
      relay = null;
    },

    isConnected(): boolean {
      return relay?.connected ?? false;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!relay?.connected) return undefined;
      const groupId = groupIdFor(platformId);

      const content = message.content as Record<string, unknown> | string | undefined;
      const text =
        typeof content === 'string' ? content : typeof content?.text === 'string' ? (content.text as string) : '';
      if (!text) return undefined;

      if (message.files?.length) {
        log.warn('Buzz: file attachments are not supported (no Buzz-implemented NIP covers it), dropping', {
          platformId,
          count: message.files.length,
        });
      }

      const template: EventTemplate = {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: text,
      };
      const signed = finalizeEvent(template, env.secretKey);
      await relay.publish(signed);
      return signed.id;
    },
  };

  return adapter;
}

/**
 * NIP-29 membership is invite-curated (you must already be an added member to
 * post), closer to Signal's linked-personal-account trust model than
 * DeltaChat's anyone-with-the-email model — hence 'strict'. Revisit to
 * 'request_approval' if real traffic shows other, non-NanoClaw-registered
 * humans posting in shared channels.
 *
 * mentions: 'never' — confirmed against real Buzz clients (desktop UI), not
 * just theorized: an "@mention" is literal text in `content`, not a `p` tag.
 * handleInboundEvent still computes isMention from a p-tag match (harmless,
 * and correct if some other Buzz client ever does tag properly), but the
 * declared default can't rely on it — group engagement falls back to a
 * name pattern instead, same shape as deltachat.ts's own no-mention-metadata
 * case. 'never' also makes validateEngageAgainstChannel reject `mention`/
 * `mention-sticky` wirings on this channel, which is the correct guard since
 * they'd never fire.
 *
 * group.engageMode is 'pattern', not 'mention-sticky': buzz has one shared
 * session per channel (supportsThreads: false), so sticky would mean
 * "engaged forever" after the first trigger.
 *
 * dm block is unused in this MVP (no NIP-17 inbound path yet) — present only
 * to satisfy ChannelDefaults' required shape.
 */
const BUZZ_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};

registerChannelAdapter('buzz', {
  factory: () => {
    const envVars = readEnvFile(['BUZZ_RELAY_URL', 'BUZZ_NSEC']);
    const relayUrl = process.env.BUZZ_RELAY_URL || envVars.BUZZ_RELAY_URL || '';
    const nsec = process.env.BUZZ_NSEC || envVars.BUZZ_NSEC || '';
    if (!relayUrl || !nsec) {
      log.debug('Buzz: BUZZ_RELAY_URL/BUZZ_NSEC not set, skipping channel');
      return null;
    }

    let secretKey: Uint8Array;
    try {
      const decoded = nip19Decode(nsec);
      if (decoded.type !== 'nsec') throw new Error(`expected an nsec1... key, got ${decoded.type}`);
      secretKey = decoded.data;
    } catch (err) {
      log.error('Buzz: BUZZ_NSEC is not a valid nsec1... key, skipping channel', { err });
      return null;
    }

    return createAdapter({ relayUrl, secretKey });
  },
  defaults: BUZZ_DEFAULTS,
});
