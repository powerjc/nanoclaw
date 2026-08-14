/**
 * Guarded handler body + hold builder for buzz_set_profile.
 *
 * requestHold exists only to satisfy DeliveryGuardSpec's required shape —
 * guard.ts's decide() never returns HOLD for buzz.set_profile (any agent
 * actor is allowed outright), so this path is unreachable today. If a
 * future, higher-stakes Buzz action needs approval-gating, give it its own
 * guard entry (see agents.create / a2a.send in
 * src/modules/agent-to-agent/guard.ts for the pattern) rather than routing
 * a real hold through here.
 *
 * applyBuzzSetProfile runs only on allow. It signs and publishes a kind:0
 * Nostr profile-metadata event using the same BUZZ_NSEC identity
 * src/channels/buzz.ts reads — never passed into the container. A short-
 * lived relay connection per call (rather than sharing buzz.ts's long-lived
 * one) is fine for a low-frequency action like a profile update; see
 * docs/buzz-mcp-tooling-spec.md for the case where a shared connection
 * would start to matter (e.g. a high-frequency reaction tool).
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import WebSocket from 'ws';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

const AUTH_WAIT_MS = 1_500;

async function loadIdentity(): Promise<{ relayUrl: string; secretKey: Uint8Array } | null> {
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

export async function requestBuzzSetProfileHold(_content: Record<string, unknown>, session: Session): Promise<void> {
  log.error('buzz_set_profile: reached requestHold — guard.ts should never return HOLD for this action', {
    sessionId: session.id,
  });
  notifyAgent(session, 'buzz_set_profile failed: unexpected approval hold (this action is not approval-gated).');
}

export async function applyBuzzSetProfile(payload: Record<string, unknown>, session: Session): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) {
    notifyAgent(session, 'buzz_set_profile failed: BUZZ_RELAY_URL/BUZZ_NSEC not configured on this host.');
    return;
  }

  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const about = typeof payload.about === 'string' ? payload.about : undefined;
  const picture = typeof payload.picture === 'string' ? payload.picture : undefined;
  if (name === undefined && about === undefined && picture === undefined) {
    notifyAgent(session, 'buzz_set_profile failed: provide at least one of name, about, picture.');
    return;
  }
  const content = JSON.stringify({
    ...(name !== undefined ? { name } : {}),
    ...(about !== undefined ? { about } : {}),
    ...(picture !== undefined ? { picture } : {}),
  });

  let relay: Relay;
  try {
    relay = await Relay.connect(identity.relayUrl, {});
  } catch (err) {
    log.error('buzz_set_profile: relay connect failed', { err });
    notifyAgent(session, 'buzz_set_profile failed: could not connect to the Buzz relay.');
    return;
  }

  try {
    const signAuthEvent = async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, identity.secretKey);
    relay.onauth = signAuthEvent;
    // Fixed wait, not buzz.ts's retry loop — a one-shot action doesn't carry
    // the long-lived reconnect story that justifies the fuller version there.
    await new Promise((resolve) => setTimeout(resolve, AUTH_WAIT_MS));
    await relay.auth(signAuthEvent).catch((err) => {
      log.warn('buzz_set_profile: explicit auth call did not complete (may already be authed via onauth)', { err });
    });

    const event = finalizeEvent(
      { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content },
      identity.secretKey,
    );
    await relay.publish(event);

    notifyAgent(session, `Buzz profile updated (event ${event.id.slice(0, 12)}...).`);
  } catch (err) {
    log.error('buzz_set_profile: publish failed', { err });
    notifyAgent(session, 'buzz_set_profile failed: could not publish the profile event.');
  } finally {
    relay.close();
  }
}
