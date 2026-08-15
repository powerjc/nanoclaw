/**
 * Regression test for a live-caught footgun: `ncl buzz set-profile
 * --instance <other>` called by an agent used to silently discard a
 * mismatched `--instance` and fall back to the caller's own wired
 * identity — no error, no signal anything was off. Live consequence: three
 * in-agent calls each meant for main/fitness/realestate instead silently
 * redirected to the calling (infra) agent's own identity and overwrote its
 * profile three times in a row, while the intended three identities were
 * never touched at all.
 *
 * `resolveInstance` is the fix and the whole surface worth testing here —
 * it's a pure function over (args, ctx) with one DB read, no relay
 * involved, so this doesn't need the nostr-tools/ws fakery buzz.test.ts
 * uses for the channel adapter.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupsByAgentGroup: vi.fn(),
}));

import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { resolveInstance } from './buzz.js';
import type { CallerContext } from '../frame.js';
import type { MessagingGroup } from '../../types.js';

function buzzGroup(instance: string): MessagingGroup {
  return {
    id: `mg-${instance}`,
    channel_type: 'buzz',
    platform_id: 'buzz:some-channel-uuid',
    instance: `buzz-${instance}`,
    name: 'general',
    is_group: 1,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

const AGENT_CTX: CallerContext = { caller: 'agent', sessionId: 's1', agentGroupId: 'ag-infra', messagingGroupId: 'mg-1' };
const HOST_CTX: CallerContext = { caller: 'host' };

describe('resolveInstance', () => {
  it('host caller requires an explicit --instance', () => {
    expect(() => resolveInstance({}, HOST_CTX)).toThrow(/--instance is required/);
  });

  it('host caller with --instance returns it verbatim', () => {
    expect(resolveInstance({ instance: 'fitness' }, HOST_CTX)).toBe('fitness');
  });

  it('agent caller with no Buzz channel wired is denied', () => {
    vi.mocked(getMessagingGroupsByAgentGroup).mockReturnValue([]);
    expect(() => resolveInstance({}, AGENT_CTX)).toThrow(/no Buzz channel wired/);
  });

  it('agent caller with no --instance resolves to their own wired identity', () => {
    vi.mocked(getMessagingGroupsByAgentGroup).mockReturnValue([buzzGroup('infra')]);
    expect(resolveInstance({}, AGENT_CTX)).toBe('infra');
  });

  it('agent caller passing --instance matching their own identity is allowed (redundant but harmless)', () => {
    vi.mocked(getMessagingGroupsByAgentGroup).mockReturnValue([buzzGroup('infra')]);
    expect(resolveInstance({ instance: 'infra' }, AGENT_CTX)).toBe('infra');
  });

  it('REGRESSION: agent caller passing --instance for a DIFFERENT identity errors — must never silently redirect to their own', () => {
    vi.mocked(getMessagingGroupsByAgentGroup).mockReturnValue([buzzGroup('infra')]);
    expect(() => resolveInstance({ instance: 'main' }, AGENT_CTX)).toThrow(/cannot target another persona's identity/);
    // The critical assertion: it must throw, not silently return "infra".
  });

  it('agent caller wired to more than one Buzz instance is denied as ambiguous', () => {
    vi.mocked(getMessagingGroupsByAgentGroup).mockReturnValue([buzzGroup('infra'), buzzGroup('main')]);
    expect(() => resolveInstance({}, AGENT_CTX)).toThrow(/wired to multiple Buzz identities/);
  });
});
