# Remove Buzz

## 1. Remove the channel adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './buzz.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/buzz.ts src/channels/buzz-registration.test.ts src/channels/buzz.test.ts
```

## 2. Remove the `ncl buzz` resource

Delete the self-registration import from `src/cli/resources/index.ts` (skip if already gone):

```typescript
import './buzz.js';
```

Remove `'buzz'` from `GROUP_SCOPE_RESOURCES` in `src/cli/registry.ts`:

```typescript
export const GROUP_SCOPE_RESOURCES = new Set(['groups', 'sessions', 'destinations', 'members', 'tasks']);
```

Delete the copied resource file:

```bash
rm -f src/cli/resources/buzz.ts
```

Remove the `buzz` row from the resource table in `container/agent-runner/src/mcp-tools/cli.instructions.md` and the mirrored table in root `CLAUDE.md`.

## 3. Remove credentials

Remove these lines from `.env`:

```
BUZZ_RELAY_URL
BUZZ_NSEC
```

## 4. Rebuild and restart

```bash
pnpm run build
sudo systemctl restart nanoclaw
```

(Or the general path: `source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)` on Linux / `launchctl kickstart -k gui/$(id -u)/$(launchd_label)` on macOS.)

## 5. Remove the dependencies (optional)

Both the channel adapter and the `ncl buzz` resource depend on these — only remove once both steps 1 and 2 are done, and only if nothing else in the project depends on them:

```bash
pnpm remove nostr-tools ws
pnpm remove -D @types/ws
```

## Verification

After removal, confirm the adapter is no longer starting:

```bash
grep "buzz" logs/nanoclaw.log | tail -5
```

Expected: no `Channel adapter started` entry for `buzz` after the last restart. `ncl buzz help` should report an unknown resource.
