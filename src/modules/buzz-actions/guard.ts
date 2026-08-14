/**
 * Guard catalog entry for agent-initiated Buzz actions that need the host's
 * BUZZ_NSEC to sign a Nostr event — the container never holds that key (see
 * src/channels/buzz.ts's identity model), so any action beyond ordinary chat
 * replies has to round-trip through a guarded delivery action like this one.
 *
 * buzz.set_profile is low-risk and self-scoped (an agent renaming/describing
 * its own Buzz identity), so it allows outright for any agent actor rather
 * than holding for admin approval on every call — same tier as a2a.send's
 * self-send case in src/modules/agent-to-agent/guard.ts. A future, more
 * sensitive Buzz action (e.g. a generic raw-event publish tool) should get
 * its own guard entry that holds, not reuse this one.
 */
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';

export const buzzSetProfile = defineGuardedAction({
  action: 'buzz.set_profile',
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('buzz_set_profile is a container-originated action.');
    return ALLOW('self-scoped profile update, no elevated risk');
  },
});
