# Intent: Add update_group IPC command

0. Also add `updateGroup` stub to the `IpcDeps` mock in `src/ipc-auth.test.ts` (not in modify/ — patch directly during apply).
1. Import `patchRegisteredGroup` from `./db.js`.
2. Add `updateGroup` to `IpcDeps` interface.
3. Extend the `processTaskIpc` data parameter type with `containerConfig` field (already has most fields).
4. Add `update_group` case to the switch:
   - Main-only (blocked for non-main groups).
   - Requires `data.jid`; target group must exist in registeredGroups.
   - Calls `deps.updateGroup(jid, { requiresTrigger, containerConfig })` with whichever fields are present.
   - Logs the update.
