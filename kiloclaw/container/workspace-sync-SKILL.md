---
name: workspace-sync
description: >
  Sync the OpenClaw workspace to GitHub. Use this skill proactively after ANY file edits,
  memory updates, config changes, or at the end of conversations. Trigger on sync, push,
  save your work, commit, back this up, or any mention of persisting workspace state.
  Also use during heartbeat maintenance. When in doubt, sync.
---

# Workspace Sync

Commit and push workspace changes to a Git remote.

## Prerequisites

- The workspace must be a git repository with a remote configured
- Git authentication must be set up (token in environment, credential helper, SSH key, etc.)
- If using HTTPS with a PAT, ensure `GH_TOKEN` or equivalent is available in the environment. Check TOOLS.md (in the workspace root, alongside MEMORY.md and AGENTS.md) for credential notes specific to this workspace. If TOOLS.md doesn't exist or has no git auth info, check `~/.bashrc`, `~/.gitconfig`, or the system credential helper.

## Workflow

1. Navigate to the workspace root. Try the git approach first; fall back to the OpenClaw default:
   ```
   cd "$(git rev-parse --show-toplevel 2>/dev/null || echo ~/.openclaw/workspace)"
   ```
   If neither works, the workspace path may be non-standard — check AGENTS.md or the OpenClaw config for `agents.defaults.workspace`.

2. Stage all changes:
   ```
   git add -A
   ```

3. Review what changed:
   ```
   git diff --cached --stat
   ```
   If the output is empty, there are no changes — skip to "When to Sync" (nothing to do).
   Otherwise, read the stat output and compose a concrete, descriptive commit message based on the actual diff. Never use a placeholder or generic message.

4. Commit:
   ```
   git commit -m "your concrete message here"
   ```

5. Push to the remote:
   ```
   git push origin $(git branch --show-current)
   ```

## Commit Message Guidelines

- Summarize what changed in plain English
- Keep it under ~72 characters when possible
- Examples:
  - "Memory update: new contacts, travel plans"
  - "Update HEARTBEAT.md with email check instructions"
  - "Add workspace-sync skill"
  - "Memory + HEARTBEAT update: added API contacts, revised email schedule, removed stale tools"
- If nothing changed, skip silently — do not report "nothing to commit"

## Error Handling

- **Auth error (403/401):** Check that the git credential (token, SSH key, credential helper) is valid. Look for auth config in TOOLS.md (workspace root), `~/.bashrc`, `~/.gitconfig`, or the system credential helper. Report to the user if unresolvable.
- **Diverged branches / rejected push:** Run `git pull --rebase origin $(git branch --show-current)` then retry the push.
- **Network error:** Wait 30 seconds and retry once. If still failing, report the error to the user.
- **Merge conflicts after rebase:** Report the conflicting files to the user — do not force push.
- Always report push failures rather than silently swallowing them.

## When to Sync

- After editing workspace files (memory, config, heartbeat, tools, skills, etc.)
- At the end of a conversation with significant changes
- During heartbeat maintenance
- When explicitly asked