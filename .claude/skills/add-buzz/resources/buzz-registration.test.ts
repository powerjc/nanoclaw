/**
 * Integration test for the buzz channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs buzz.ts's top-level `registerBuzzInstances()`, which registers
 * one adapter per BUZZ_INSTANCES entry; without the import no buzz instance
 * is ever registered.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains a buzz-prefixed instance. This reflects what happens at host
 * boot — if the `import './buzz.js';` line is deleted, or the barrel fails to
 * evaluate for any reason (so the channel genuinely would not register), this
 * goes red. A structural check of the import line would falsely pass in that
 * second case.
 *
 * Registration itself (not just the factory) is now conditional on
 * BUZZ_INSTANCES/BUZZ_RELAY_URL being set — multi-instance means the adapter
 * can't register under one fixed name the way single-instance channels do, it
 * has to read config to know what instances exist at all. So this test sets
 * that config itself rather than relying on the real .env (which would make
 * the test pass or fail based on host-specific credentials, not on whether
 * the barrel import is intact).
 *
 * Importing the barrel is safe: registration is a pure top-level call, and
 * buzz.ts only connects to the relay inside setup() (run at host startup),
 * never at import — so nothing spawns here. It does require the `nostr-tools`
 * and `ws` packages to be installed, which holds in a composed install: the
 * skill's `pnpm install` step runs before this test in the apply flow.
 */
import { beforeEach, describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';

describe('buzz channel registration', () => {
  beforeEach(() => {
    process.env.BUZZ_RELAY_URL = 'ws://fake-relay:3000';
    process.env.BUZZ_INSTANCES = 'test';
  });

  it('registers a buzz instance via the channel barrel', async () => {
    await import('./index.js'); // the real barrel — triggers every channel's self-registration
    expect(getRegisteredChannelNames()).toContain('buzz-test');
  });
});
