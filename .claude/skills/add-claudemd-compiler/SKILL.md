---
name: add-claudemd-compiler
description: Add CLAUDE.md Import Compilation to NanoClaw.
---

# Add CLAUDE.md Compiler

This skill intercepts the CLAUDE.md mount and statically compiles recursive `@import` directives into a single markdown file before passing it into the container.

Apply this skill using:
`npx tsx scripts/apply-skill.ts .claude/skills/add-claudemd-compiler`
