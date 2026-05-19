---
name: git-rebase
description: Use when rebasing branches in this repo; handling non-fast-forward push rejections; deciding whether to merge, rebase, cherry-pick, or force-with-lease; recovering from polluted PR history; resolving migration conflicts during rebase. Enforces repo git safety rules, clean reviewable history, and explicit approval gates for branch rewrites.
compatibility: Requires git and pnpm in PATH; repository must have an origin remote.
---

# Git rebase and PR branch hygiene

Keep PR history clean. Treat rebases, non-fast-forward push rejections, and branch rewrites as topology problems, not file-content problems.

## Required repo rules

- Read and follow root `AGENTS.md` and any nested `AGENTS.md` before changing files.
- Never use `--force`, `--no-verify`, or hook-bypass flags without explicit user approval.
- Prefer `git push --force-with-lease` over `git push --force`; still ask first.
- If hooks/checks fail, diagnose and fix or ask; do not bypass silently.
- Run `pnpm format` before committing. For verification, prefer targeted checks; avoid full `pnpm typecheck` by default because it is slow.
- For migration conflicts: never hand-write or hand-edit generated migration SQL, snapshots, or journal entries. Delete branch-local generated migration artifacts, rerun `pnpm drizzle generate`, then re-append intentional backfill SQL after generated DDL using `-->  statement-breakpoint` separators.

## Start every rebase/branch-cleanup task

```bash
git status --short --branch
branch=$(git branch --show-current)
git fetch origin main
git fetch origin "$branch" || true
git rev-list --count origin/main..HEAD
git log --oneline --decorate origin/main..HEAD
git log --oneline --left-right --graph HEAD...origin/$branch || true
```

Then state:

- current branch;
- whether the worktree is clean;
- local-only commit count and subjects;
- remote-only commits, if any;
- expected reviewable commit count, if known;
- whether the remote branch appears authoritative, stale, or uncertain.

Do not start a rebase with an unexplained dirty worktree. If on `main` or another protected/base branch, stop and ask.

If the user approves stashing dirty work, use a named stash and restore it after the rebase:

```bash
git stash push -u -m "pre-rebase-$branch-$(date +%Y%m%d%H%M%S)"
git stash list -1
```

After the rebase and verification, run `git stash pop`, report restored tracked/untracked files, and leave them unstaged unless the user asked otherwise.

## Before rewriting local history

Create a backup branch unless the user explicitly declines:

```bash
backup="backup/${branch}-pre-rebase-$(date +%Y%m%d%H%M%S)"
git branch "$backup" HEAD
```

Use `git rebase origin/main` for normal base refreshes. Use interactive rebase only when the user asked to reorder/squash/edit commits or when you first explain the intended rewrite.

If post-rebase cleanup creates files that belong in an earlier logical commit, state the intended local rewrite before using `git commit --fixup` plus `git rebase -i --autosquash` or `git commit --amend`. Rerun final topology verification afterward.

After the rebase, verify topology and content:

```bash
git status --short --branch
git rev-list --count origin/main..HEAD
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git range-diff origin/main...$backup origin/main...HEAD || true
```

After resolving conflicts, check resolved files for conflict markers and whitespace errors before final reporting:

```bash
rg -n '^<<<<<<<|^=======$|^>>>>>>>' <resolved-files> || true
git diff --check
```

If final content must match a backup/bad-history branch exactly:

```bash
git diff --quiet HEAD "$backup"
echo $?
```

Exit code `0` means file trees match.

## Migration conflict procedure

When rebase conflicts touch `packages/db/src/migrations/`:

1. Identify branch-local generated migration artifacts. During an interrupted rebase, prefer the pre-rebase backup branch if `HEAD` no longer contains all branch commits:

   ```bash
   git diff --name-only --diff-filter=A origin/main...$backup -- packages/db/src/migrations
   git diff --name-only --diff-filter=A origin/main...HEAD -- packages/db/src/migrations
   ```

2. Do not manually resolve generated migration SQL, snapshots, or journal JSON.
3. Remove branch-local generated migration SQL, snapshot, and journal entries involved in the conflict.
4. If generated snapshot or journal conflicts block `git rebase --continue`, stage the current/base migration metadata as a temporary conflict resolution, then continue the rebase.
5. After the rebase reaches the target branch tip, rerun generation from the rebased schema:

   ```bash
   pnpm drizzle generate
   ```

6. Re-append any intentional backfill SQL after generated DDL with `-->  statement-breakpoint` separators.
7. If regenerated migration files belong in an earlier logical commit, use the post-rebase cleanup guidance above.
8. Prefer a single regenerated migration per feature branch when it has not shipped.

## Non-fast-forward push rejection

If `git push` is rejected as non-fast-forward, stop. Do not run `git pull`, `git merge origin/$branch`, or `git merge` reflexively.

Inspect divergence:

```bash
git fetch origin "$branch"
git log --oneline --left-right --graph HEAD...origin/$branch
git rev-list --count origin/main..HEAD
git rev-list --count origin/main..origin/$branch
```

Interpretation:

- `<` = local-only commits.
- `>` = remote-only commits.

Classify before acting:

- **Remote is stale**: remote-only commits are old/duplicate PR lineage and local branch is the cleaned intended history. Ask for approval to replace the remote with force-with-lease.
- **Remote has real work**: remote-only commits contain collaborator or authoritative changes. Ask whether to merge, rebase, or cherry-pick them.
- **Uncertain**: stop and ask.

After a base refresh, `git log --left-right HEAD...origin/$branch` may show new `origin/main` commits as local-only noise. Use range-diff and commit-subject comparison to classify the remote branch:

```bash
git range-diff origin/main...origin/$branch origin/main...HEAD || true
```

If range-diff shows the same PR commits rewritten onto the new base and no collaborator work, treat the remote as stale.

Use this approval prompt for stale remote history:

> The remote PR branch appears stale. To keep the PR clean, I need to replace it with the local branch using `git push --force-with-lease`. Approve?

Only after approval:

```bash
expected=$(git rev-parse origin/$branch)
git branch "backup/${branch}-remote-before-rewrite-$(date +%Y%m%d%H%M%S)" "origin/$branch"
git push --force-with-lease=refs/heads/$branch:$expected origin HEAD:$branch
```

Then verify the remote:

```bash
git fetch origin "$branch"
git rev-list --count origin/main..origin/$branch
git log --oneline --decorate origin/main..origin/$branch
```

## Clean-branch recovery for polluted PR history

Use when a PR branch has correct final content but duplicate/stale commits or merge pollution.

```bash
branch=$(git branch --show-current)
git branch "backup/${branch}-bad-history" HEAD
git fetch origin main
git switch -c "${branch}-clean" origin/main
git diff --no-ext-diff --binary origin/main "backup/${branch}-bad-history" > "/tmp/${branch}-clean.patch"
git apply "/tmp/${branch}-clean.patch"
```

Recreate logical commits manually in reviewable groups:

```bash
git add <paths>
git commit -m "type(scope): summary"
```

Before replacing the PR branch:

```bash
git rev-list --count origin/main..HEAD
git log --oneline --decorate origin/main..HEAD
git diff --quiet HEAD "backup/${branch}-bad-history"
echo $?
```

If the tree matches and the commit count is expected, ask for approval, then push with explicit lease.

## Output contract

For rebase/push decisions, report:

```text
Branch: <name>
Worktree: clean|dirty (<summary>)
Local commits vs origin/main: <count>
Remote divergence: none|stale|real-work|uncertain
Recommended action: <rebase|normal push|force-with-lease after approval|ask user|recover clean branch>
Approval needed: yes|no (<why>)
Verification: <commands run / commands still needed>
```
