---
name: update-group-config
description: Add update_group IPC command so the main agent can update requiresTrigger and additionalMounts for any registered group at runtime, without direct DB access.
---

# Skill: update-group-config

Adds an `update_group` IPC task type. The main agent can now send an IPC task
to change a group's `requiresTrigger` flag or `containerConfig` (mounts) at
runtime. Changes take effect immediately — no restart required.

## IPC payload (from agent)

```json
{
  "type": "update_group",
  "jid": "tg:-5166476122",
  "requiresTrigger": false,
  "containerConfig": {
    "additionalMounts": [
      { "hostPath": "/mnt/obsidian", "containerPath": "obsidian", "readonly": true },
      { "hostPath": "/mnt/obsidian/Jarvis", "containerPath": "obsidian/Jarvis", "readonly": false }
    ]
  }
}
```

Both `requiresTrigger` and `containerConfig` are optional — omit any you don't want to change.
Mount validation still runs at container spawn time via the existing allowlist.

## Phase 1: Apply Code Changes

Apply the three patched source files from this skill:

```bash
cp .claude/skills/update-group-config/modify/src/db.ts src/db.ts
cp .claude/skills/update-group-config/modify/src/ipc.ts src/ipc.ts
cp .claude/skills/update-group-config/modify/src/index.ts src/index.ts
```

## Phase 2: Build and Restart

```bash
npm run build
sudo systemctl restart nanoclaw
```

## Phase 3: Update Agent CLAUDE.md

Add the `update_group` IPC docs to the main agent's CLAUDE.md so Jarvis knows how to use it. In the "Managing Groups" section, add an "Updating Group Config at Runtime" subsection after "Adding Additional Directories for a Group":

```markdown
### Updating Group Config at Runtime

Use `update_group` to change `requiresTrigger` or `containerConfig` for any registered group without restarting. Changes take effect immediately.

\`\`\`bash
echo '{
  "type": "update_group",
  "jid": "tg:-5166476122",
  "requiresTrigger": false,
  "containerConfig": {
    "additionalMounts": [
      { "hostPath": "/mnt/obsidian", "containerPath": "obsidian", "readonly": true }
    ]
  }
}' > /workspace/ipc/tasks/update_group_$(date +%s).json
\`\`\`

Both fields are optional. Mounts are validated against the host allowlist at container spawn time.
```

Also fix the stale "Removing a Group" and "Listing Groups" sections if they still reference `registered_groups.json` — they should use `sqlite3 /workspace/project/store/messages.db` instead.

## Phase 4: Verify

Send an IPC task from the main agent to toggle `requiresTrigger` on a group,
then send a message to that group without a trigger word and confirm the agent
responds (or not) as expected.
