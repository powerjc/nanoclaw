# Intent: Add CLAUDE.md compiler

This skill replaces the core `compileClaudeMd` logic with an imported version from `claude-md-compiler.ts`. It also intercepts the `buildContainerArgs` mounting pipeline to dynamically process the group's CLAUDE.md.
