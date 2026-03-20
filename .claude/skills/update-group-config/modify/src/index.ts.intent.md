# Intent: Wire updateGroup into IpcDeps

1. Import `patchRegisteredGroup` from `./db.js`.
2. Add `updateGroup(jid, patch)` function alongside `registerGroup`:
   - Merges patch into the in-memory `registeredGroups[jid]`.
   - Calls `patchRegisteredGroup(jid, patch)` to persist to DB.
   - Logs the update.
3. Pass `updateGroup` as a dep to `startIpcWatcher`.
