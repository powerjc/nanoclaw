---
name: add-paperless-mcp
description: Add Paperless-ngx Integration to NanoClaw.
---

# Add Paperless-ngx Integration

This skill adds the ability of the agent to interface with your Paperless-ngx instance.

## Configuration

You must add the following variables to your NanoClaw `.env` file for the tool to work:
- `PAPERLESS_URL`
- `PAPERLESS_TOKEN`

Apply this skill using:
`npx tsx scripts/apply-skill.ts .claude/skills/add-paperless-mcp`
