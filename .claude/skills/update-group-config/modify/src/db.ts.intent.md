# Intent: Add patchRegisteredGroup

1. Add `ContainerConfig` to the types import.
2. Add `patchRegisteredGroup(jid, patch)` after `setRegisteredGroup`.
   - Accepts `{ requiresTrigger?: boolean; containerConfig?: ContainerConfig }`.
   - Builds a partial UPDATE — only sets columns that are present in the patch.
   - Returns `true` if a row was updated, `false` if jid not found or patch empty.
   - Mirrors the pattern used by `updateTask` for partial updates.
