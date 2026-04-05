# Task: Migrate this branch to the new monorepo structure

The repo's `main` branch was restructured in commit `64f4503b7` which moved
~3400 files from a flat layout into `apps/`, `packages/`, `services/`
directories. This branch predates that restructure. Your job is to re-apply
this branch's changes onto the new structure so it can cleanly merge into
`main`.

## 0. Preflight checks

```bash
# Fetch first — all subsequent commands depend on an up-to-date origin/main.
git fetch origin main

# This branch must NOT already contain the restructure commit.
# If this command exits 0, STOP — the branch already has the new structure.
git merge-base --is-ancestor 64f4503b7 HEAD

# The worktree must be clean. If this produces output, STOP and ask the user
# to commit or stash first.
git status --porcelain
```

If either check fails, stop and report why.

## 1. Identify what this branch changed

Run the following two commands and **record the output values** — you will need
to substitute them literally into commands in later steps. Do not rely on shell
variables persisting between commands.

```bash
git merge-base origin/main HEAD
# Record this as OLD_BASE (e.g. "3adb7c7dc...")

git branch --show-current
# Record this as OLD_BRANCH (e.g. "my-feature")
```

Then generate the file list:

```bash
git diff <OLD_BASE>...HEAD --name-status
```

(Substitute the literal OLD_BASE hash.)

Save this file list — these are the only files you need to migrate. The status
codes you may see:

| Status | Meaning  | How to handle                                                                                |
| ------ | -------- | -------------------------------------------------------------------------------------------- |
| `M`    | Modified | Apply the diff to the file at its new path                                                   |
| `A`    | Added    | Create at the mapped new path (see safety rule below)                                        |
| `D`    | Deleted  | Delete at the mapped new path                                                                |
| `R###` | Renamed  | Treat as a delete of the old path + add of the new path, both mapped through the table below |
| `C###` | Copied   | Treat as an add of the destination path, mapped through the table below                      |

## 2. Path mapping

The restructure renamed paths as follows. For `cloudflare-*` workers, the
`cloudflare-` prefix was stripped:

| Old path (this branch)              | New path (main)                     |
| ----------------------------------- | ----------------------------------- |
| `src/`                              | `apps/web/src/`                     |
| `public/`                           | `apps/web/public/`                  |
| `dev/`                              | `apps/web/dev/`                     |
| `tests/`                            | `apps/web/tests/`                   |
| `storybook/`                        | `apps/storybook/`                   |
| `kilo-app/`                         | `apps/mobile/`                      |
| `cloud-agent/`                      | `services/cloud-agent/`             |
| `cloud-agent-next/`                 | `services/cloud-agent-next/`        |
| `cloudflare-gastown/`               | `services/gastown/`                 |
| `cloudflare-deploy-infra/`          | `services/deploy-infra/`            |
| `cloudflare-o11y/`                  | `services/o11y/`                    |
| `cloudflare-<name>/`                | `services/<name>/`                  |
| `kiloclaw/`                         | `services/kiloclaw/`                |
| `kiloclaw/packages/secret-catalog/` | `packages/kiloclaw-secret-catalog/` |
| `packages/*`                        | `packages/*` (unchanged)            |

Many root-level Next.js config files (`next.config.mjs`, `tsconfig.json`,
`jest.config.ts`, `playwright.config.ts`, `vercel.json`, etc.) moved into
`apps/web/`. However, some root-level env files are still consumed at the root
(notably `packages/db/drizzle.config.ts` reads `../../.env.local` from repo
root, and CI copies `.env.local` back to root). Do not blindly move all `.env*`
files — verify each one's consumers.

The root `package.json` was split: it is now a lean workspace root
(`kilocode-monorepo`), and the Next.js app deps live in `apps/web/package.json`
(package name changed from `kilocode-backend` to `web`).

**Important:** Workspace directory names do not always match `package.json`
names. When running `pnpm --filter`, always use the name from the workspace's
`package.json`, not the directory name. Known divergences:

| Directory           | `package.json` name   |
| ------------------- | --------------------- |
| `apps/web/`         | `web`                 |
| `apps/mobile/`      | `kilo-app`            |
| `apps/storybook/`   | `@kilocode/storybook` |
| `services/o11y/`    | `cloudflare-o11y`     |
| `services/gastown/` | `cloudflare-gastown`  |

## 3. Create migration branch

```bash
git checkout -b <OLD_BRANCH>-v2 origin/main
```

(Substitute the literal branch name recorded in step 1.)

## 4. Migrate changes

Work through the file list from step 1. Split the work into two buckets:

### Bucket A: Source files

For files under `src/`, `public/`, `dev/`, `tests/`, `storybook/`, `kilo-app/`,
`cloud-agent*/`, `cloudflare-*/`, `kiloclaw/`, and `packages/`:

- **Modified (M):** Extract the diff from the old branch for each file:

  ```bash
  git diff <OLD_BASE>...<OLD_BRANCH> -- <old-path>
  ```

  Read the file at its mapped new path on this branch. Re-apply only the
  logical changes from the diff. Do NOT use `git apply` — context lines won't
  match due to other changes on `main`.

- **Added (A):** Check whether a file already exists at the mapped new path. If
  it does NOT exist, retrieve the content and write it:

  ```bash
  git show <OLD_BRANCH>:<old-path>
  ```

  If the file DOES already exist at the new path, treat it as a merge: compare
  the old branch's version with the existing file and integrate the intent.

- **Deleted (D):** Delete the file at its mapped new path, if it still exists.

- **Renamed (R):** Map both the source and destination through the path table.
  Delete the file at the mapped old path (if it exists) and create/write the
  file at the mapped new path (following the same safety rule as Added files).

- **Copied (C):** Map the destination through the path table and treat as an
  Added file.

### Bucket B: Config, scripts, and workflow files

These files were heavily modified in the restructure and must be handled with
extra care. Do NOT copy them from the old branch. For each one:

1. Read what the old branch changed vs the old base:
   ```bash
   git diff <OLD_BASE>...<OLD_BRANCH> -- <file>
   ```
2. Read the current version of the file on this branch (which is `origin/main`).
3. Apply only the branch's logical intent to the current version.

This applies to files like:

- `package.json` (root and any workspace-level)
- `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- `.github/workflows/*.yml`
- `scripts/*.sh`
- `.oxlintrc.json`, `.prettierignore`, `.gitignore`
- `tsconfig.json` (root or any workspace-level)

## 5. Scan for stale path references

After migrating all files, scan the entire working tree for references to old
paths that may have been carried over:

```bash
rg -n \
  -e 'kilocode-backend' \
  -e '"src/' -e "'src/" -e ' src/' \
  -e 'public/' \
  -e 'tests/' \
  -e '/dev/local' \
  -e '\.dev-port' \
  -e '\.env\.local' \
  -e 'kilo-app/' \
  -e 'cloud-agent/' \
  -e 'cloudflare-' \
  -e 'kiloclaw/' \
  -e 'storybook/' \
  . \
  --glob '!.git' \
  --glob '!node_modules' \
  --glob '!*.lock' \
  --glob '!pnpm-lock.yaml' \
  --glob '!plans/'
```

Review every hit. False positives are expected (e.g. `storybook/` inside
`apps/storybook/` is fine, `cloudflare-` in a Cloudflare SDK package name is
fine). But any reference that assumes the old directory layout must be updated.
Pay particular attention to:

- Import paths and aliases (`@/` still resolves within `apps/web/src/`)
- CI workflow path filters and working-directory settings
- Shell scripts that reference old directory names
- `.env` file paths and `.dev-port` assumptions
- Workspace names (`kilocode-backend` → `web`)
- Root-level config files (`package.json`, `pnpm-workspace.yaml`, etc.)

## 6. Verify

Run the following and fix any failures:

```bash
pnpm install
pnpm typecheck
pnpm lint
```

Then run workspace-level tests/builds for the areas this branch touched. Read
the workspace's `package.json` to get the correct filter name. For example, if
the branch modified files in `apps/web/`:

```bash
pnpm --filter web test
pnpm --filter web build
```

If it touched a worker like `services/o11y/`:

```bash
# Note: directory is o11y but package name is cloudflare-o11y
pnpm --filter cloudflare-o11y typecheck
```

Adapt to whichever workspaces were affected.

## 7. Commit

```bash
git add -A
git commit -m "chore: migrate <OLD_BRANCH> to monorepo structure"
```

(Substitute the literal branch name.)

## 8. Report

After completing the migration, provide a short report:

- **Files migrated:** count and list
- **Files skipped:** any files that couldn't be mapped or whose target no
  longer exists, with reasons
- **Renames/copies handled:** any R/C entries and how they were resolved
- **Stale references found and fixed:** from the `rg` scan
- **Config/workflow changes:** what was manually adjusted in bucket B files
- **Verification results:** pass/fail for each command run in step 6

## Rules

- Do NOT rebase the old branch onto main. The 3400-file rename creates
  unresolvable conflicts.
- Do NOT copy entire files from the old branch over files at new paths — `main`
  has other changes since the branch diverged. Always apply only the diff.
- If the branch modified a file that no longer exists on `main` and is not
  covered by the mapping, flag it in the report and skip.
- A single squashed commit is fine.
