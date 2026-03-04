---
name: add-media-mcp
description: Add Sonarr/Radarr MCP Server to NanoClaw.
---

# Add Media MCP Integration

This skill adds the `sonarr_radarr` MCP server, allowing NanoClaw to manage and search your home media library.

## Configuration

You must add the following variables to your NanoClaw `.env` file for the tool to work:
- `SONARR_URL`
- `SONARR_API_KEY`
- `RADARR_URL`
- `RADARR_API_KEY`

Apply this skill using:
`npx tsx scripts/apply-skill.ts .claude/skills/add-media-mcp`
