# Agent Instructions

This project uses **tk** (ticket) for issue tracking. Run `tk help` to get started.

## Quick Reference

```bash
tk ready              # Find unblocked work
tk show <id>          # View ticket details
tk start <id>         # Mark in progress
tk close <id>         # Close completed ticket
tk create "Title"     # Create a new ticket
tk list               # List tickets
```

## Logging Policy (CRITICAL)

**NEVER use `console.log`, `console.error`, or `console.warn`**.

- **Plugin code** (`src/index.ts`, `src/plugin/*`): Use the provided `log(message, level, extra)` function from the plugin context.
- **Daemon code** (`src/daemon/*`): Use the `log()` function from `src/daemon/logger.ts`. Signature: `log(message, level?, extra?)`.
- **Relay code** (`src/relay/*`): Use the `log` function passed via config.

This ensures logs are captured by the OpenCode plugin system and visible in the UI, and daemon logs go to the centralized logger.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Code Changes

**NEVER checkout or restore files without saving current work first:**
1. `git stash push -m "descriptive-name"` OR create a branch
2. THEN checkout/restore

**Before "fixing" working code:**
1. Understand WHY it works, not just WHAT it does
2. Test that it actually works first
3. Make ONE small change at a time
4. Test after EACH change
5. If it breaks, revert immediately
