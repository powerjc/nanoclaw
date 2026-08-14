/**
 * Buzz actions module — agent-initiated Buzz operations that need the host's
 * BUZZ_NSEC identity (see src/channels/buzz.ts). Proof-of-concept scope:
 * buzz_set_profile only. See docs/buzz-mcp-tooling-spec.md for the fuller
 * planned tool surface (reactions, search, DM send, channel admin) and why
 * each one would follow this same guarded-delivery-action shape rather than
 * a bespoke path.
 *
 * Without this module: the buzz_set_profile MCP tool in the container still
 * writes an outbound system message with this action, but delivery logs
 * "Unknown system action" and drops it — same fallback as self-mod's actions
 * when that module isn't installed.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { applyBuzzSetProfile, requestBuzzSetProfileHold } from './apply.js';
import { buzzSetProfile } from './guard.js';

registerDeliveryAction('buzz_set_profile', applyBuzzSetProfile, {
  guardAction: buzzSetProfile,
  requestHold: requestBuzzSetProfileHold,
});
