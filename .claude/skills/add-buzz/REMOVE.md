# Remove Buzz

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './buzz.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/buzz.ts src/channels/buzz-registration.test.ts src/channels/buzz.test.ts
```

## 2. Remove credentials

Remove these lines from `.env`:

```
BUZZ_RELAY_URL
BUZZ_NSEC
```

## 3. Rebuild and restart

```bash
pnpm run build
sudo systemctl restart nanoclaw
```

(Or the general path: `source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)` on Linux / `launchctl kickstart -k gui/$(id -u)/$(launchd_label)` on macOS.)

## 4. Remove the dependencies (optional)

Only if nothing else in the project depends on them:

```bash
pnpm remove nostr-tools ws
pnpm remove -D @types/ws
```

## Verification

After removal, confirm the adapter is no longer starting:

```bash
grep "buzz" logs/nanoclaw.log | tail -5
```

Expected: no `Channel adapter started` entry for `buzz` after the last restart.
