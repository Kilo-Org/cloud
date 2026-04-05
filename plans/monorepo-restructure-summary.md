# Monorepo Restructure — Implementation Summary

Executed on 2026-04-05. Implements the plan in `plans/monorepo-restructure.md`.

## Commits

| Commit    | Phase | Description                                                                   |
| --------- | ----- | ----------------------------------------------------------------------------- |
| `358df11` | 1     | Create directory scaffolding (`apps/`, `services/`)                           |
| `ca0a269` | 2 + 8 | Move Next.js app to `apps/web/`, split package.json, create lean root         |
| `20cd5df` | 3     | Move Storybook to `apps/storybook/`, kilo-app to `apps/mobile/`               |
| `3668663` | 4     | Move 19 workers to `services/`, strip `cloudflare-` prefix                    |
| `fa4bd0f` | 5     | Move `kiloclaw/packages/secret-catalog` to `packages/kiloclaw-secret-catalog` |
| `4096f4f` | 6     | Switch `pnpm-workspace.yaml` to globs, rewrite shell scripts                  |
| `3da92cf` | 7     | Update all 8 GitHub Actions workflows                                         |
| `09cf1f7` | 9     | Update `.prettierignore`, `.gitignore`, `.kilocodeignore`                     |
| `97e6678` | 10    | Add `@typescript/native-preview` to root devDeps (verification fix)           |
| `bc35ced` | 10    | Fix lint: `@jest/globals` in `@kilocode/db`, `.oxlintrc.json` ignorePatterns  |

Phase 8 (lean root `package.json`) was done atomically with Phase 2 since both must happen together. Phase 11 (external configuration) is manual post-merge work.

## What changed

### Directory structure

```
BEFORE                              AFTER
/src/                        →      /apps/web/src/
/public/                     →      /apps/web/public/
/tests/                      →      /apps/web/tests/
/dev/                        →      /apps/web/dev/
/storybook/                  →      /apps/storybook/
/kilo-app/                   →      /apps/mobile/
/cloud-agent/                →      /services/cloud-agent/
/cloud-agent-next/           →      /services/cloud-agent-next/
/cloudflare-gastown/         →      /services/gastown/
/cloudflare-deploy-infra/    →      /services/deploy-infra/
/cloudflare-*                →      /services/* (prefix stripped)
/kiloclaw/                   →      /services/kiloclaw/
/kiloclaw/packages/secret-catalog/  →  /packages/kiloclaw-secret-catalog/
```

Config files (`next.config.mjs`, `tsconfig.json`, `jest.config.ts`, `playwright.config.ts`, `.env`, `vercel.json`, etc.) moved into `apps/web/`.

### package.json split

- **Root** (`kilocode-monorepo`): Lean workspace root with `husky`, `oxlint`, `oxfmt`, `typescript`, `@typescript/native-preview`. Scripts delegate to workspaces via `pnpm --filter`.
- **`apps/web`** (`web`): All Next.js dependencies and app-specific scripts. Renamed from `kilocode-backend` to `web`.

### pnpm-workspace.yaml

Replaced 30+ explicit entries with glob patterns:

```yaml
packages:
  - apps/*
  - services/*
  - services/cloud-agent/wrapper
  - services/cloud-agent-next/wrapper
  - services/gastown/container
  - services/deploy-infra/builder
  - services/deploy-infra/dispatcher
  - packages/*
```

### Scripts updated

- **`scripts/typecheck-all.sh`**: `kilocode-backend` → `web` (4 occurrences), `tsgo --noEmit` → `tsgo --noEmit -p apps/web/tsconfig.json`
- **`scripts/lint-all.sh`**: Rewritten to use `pnpm ls --json -r --depth -1` for glob-aware workspace resolution instead of parsing `pnpm-workspace.yaml` literally
- **`scripts/changed-workspaces.sh`**: Same glob-aware rewrite
- **`scripts/dev.sh`**: Writes `.dev-port` to workspace root via `git rev-parse --show-toplevel`
- **`scripts/worktree-prepare.sh`**: `.env.development.local` → `apps/web/.env.development.local`

### Path references fixed

- `apps/web/tsconfig.json`: `@kilocode/db` etc. paths prefixed with `../../`
- `apps/web/tsconfig.scripts.json`: Same `../../` prefix
- `apps/web/jest.config.ts`: `moduleNameMapper` and `testPathIgnorePatterns` updated for `../../packages/` and `../../services/`
- `apps/storybook/tsconfig.json`: Extends `../web/tsconfig.json`, includes `../web/src/**/*`
- `packages/trpc/src/index.ts`: Re-export path updated to `../../../apps/web/src/routers/root-router`
- `packages/trpc/tsconfig.json`: `@/*` path and includes updated for `apps/web/`
- `apps/web/src/lib/app-builder/`: Relative imports updated to `../../../../../services/`
- All 21 service `package.json` lint scripts: Updated from old paths to `services/*/src`
- `apps/mobile/package.json` lint script: `kilo-app/` → `apps/mobile/`

### GitHub Actions workflows

All 8 workflows updated (trufflehog needed no changes):

- **ci.yml**: paths-filter, `.next/cache`, wrapper working-directories, `--exclude apps/web` on `changed-workspaces.sh`, Vercel `working-directory: apps/web`
- **deploy-production.yml**: `.next/cache` (×2), kiloclaw filter, Vercel working-directories
- **deploy-workers.yml**: All 19 WORKERS array entries
- **deploy-kiloclaw.yml**: ~15 `kiloclaw/` → `services/kiloclaw/` references
- **bump-openclaw.yml**: Dockerfile path
- **chromatic.yml**: `storybook/` → `apps/storybook/`
- **kilo-app-ci.yml**: `kilo-app/` → `apps/mobile/`, `src/routers/` → `apps/web/src/routers/`
- **kilo-app-release.yml**: `kilo-app/` → `apps/mobile/`

### Lint fixes

- **`@kilocode/db`**: Added `@jest/globals` devDependency, explicit `import { describe, it }` in `schema.test.ts` (resolved `no-unsafe-call` on untyped globals)
- **`.oxlintrc.json`**: Changed `src/lib/gastown/types/**` → `**/gastown/types/**` and `src/types/opencode.gen.ts` → `**/types/opencode.gen.ts` so patterns work when oxlint targets `apps/web/src`

## Verification results

| Check                                              | Result                               |
| -------------------------------------------------- | ------------------------------------ |
| `pnpm install`                                     | Pass                                 |
| `pnpm --filter web typecheck`                      | Pass                                 |
| `pnpm --filter kilo-app typecheck`                 | Pass                                 |
| `pnpm --filter cloud-agent-next typecheck`         | Pass                                 |
| `pnpm -r lint`                                     | Pass (0 errors across 31 workspaces) |
| `scripts/changed-workspaces.sh --exclude apps/web` | Pass (correct JSON output)           |

## Post-merge manual steps (Phase 11)

- [ ] Update Vercel dashboard "Root Directory" to `apps/web` for `kilocode-app`, `kilocode-global-app`, and `kilocode-gateway` projects
- [ ] Update Sentry source map paths if configured externally
- [ ] Update EAS (Expo) project config if it references `kilo-app/` paths
