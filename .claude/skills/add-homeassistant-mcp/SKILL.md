---
name: add-homeassistant-mcp
description: Add Home Assistant Integration to NanoClaw.
---

# Add Home Assistant Integration

This skill adds the ability of the agent to control your smart home devices and manage your shopping list.

## Configuration

You must add the following variables to your NanoClaw `.env` file for the tool to work:
- `HA_URL`
- `HA_TOKEN`

Apply this skill using:
`npx tsx scripts/apply-skill.ts .claude/skills/add-homeassistant-mcp`
