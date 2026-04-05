# Monorepo Restructure Plan

## Goal

Refactor the repo from a flat layout (where the root is both the pnpm workspace root AND the Next.js app) into a standard pnpm monorepo with clear separation: `apps/`, `services/`, and `packages/`.

## Target Structure

```
/
├── apps/
│   ├── web/                                     # Next.js app (from root src/ + configs)
│   │   ├── src/
│   │   ├── public/
│   │   ├── tests/                               # E2E / Playwright
│   │   ├── dev/                                 # Dev utilities
│   │   ├── package.json                         # Next.js deps only
│   │   ├── next.config.mjs
│   │   ├── vercel.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.scripts.json
│   │   ├── jest.config.ts
│   │   ├── playwright.config.ts
│   │   ├── postcss.config.mjs
│   │   ├── components.json
│   │   ├── knip.ts                              # Web-specific knip config
│   │   ├── .env / .env.test / .env.development.local.example
│   │   ├── instrumentation-client.ts
│   │   ├── sentry.edge.config.ts
│   │   ├── sentry.server.config.ts
│   │   ├── mdx-components.tsx
│   │   ├── .madgerc
│   │   ├── .dependency-cruiser.js
│   │   ├── .vercelignore
│   │   └── skills-lock.json
│   ├── storybook/                               # Storybook (from root storybook/)
│   └── mobile/                                  # React Native Expo app (from root kilo-app/)
│       ├── src/
│       ├── assets/
│       ├── package.json
│       ├── app.config.js
│       ├── metro.config.js
│       ├── eas.json
│       ├── tsconfig.json
│       ├── knip.json
│       ├── .oxlintrc.json
│       └── components.json
│
├── services/                                    # Cloudflare Workers (cloudflare- prefix stripped)
│   ├── cloud-agent/
│   │   └── wrapper/
│   ├── cloud-agent-next/
│   │   └── wrapper/
│   ├── gastown/                                 # was cloudflare-gastown
│   │   └── container/
│   ├── deploy-infra/                            # was cloudflare-deploy-infra
│   │   ├── builder/
│   │   ├── dispatcher/
│   │   └── builder-docker-container/
│   ├── kiloclaw/
│   │   ├── controller/
│   │   └── packages/secret-catalog/             # stays here until Phase 5
│   ├── app-builder/                             # was cloudflare-app-builder
│   ├── code-review-infra/                       # was cloudflare-code-review-infra
│   ├── auto-triage-infra/                       # was cloudflare-auto-triage-infra
│   ├── auto-fix-infra/                          # was cloudflare-auto-fix-infra
│   ├── ai-attribution/                          # was cloudflare-ai-attribution
│   ├── db-proxy/                                # was cloudflare-db-proxy
│   ├── webhook-agent-ingest/                    # was cloudflare-webhook-agent-ingest
│   ├── session-ingest/                          # was cloudflare-session-ingest
│   ├── o11y/                                    # was cloudflare-o11y
│   ├── git-token-service/                       # was cloudflare-git-token-service
│   ├── security-sync/                           # was cloudflare-security-sync
│   ├── security-auto-analysis/                  # was cloudflare-security-auto-analysis
│   ├── gmail-push/                              # was cloudflare-gmail-push
│   └── images-mcp/                              # was cloudflare-images-mcp
│
├── packages/                                    # Shared libraries
│   ├── db/
│   ├── worker-utils/
│   ├── encryption/
│   ├── trpc/                                    # Shared tRPC router types
│   └── kiloclaw-secret-catalog/                 # Moved from kiloclaw/packages/secret-catalog/
│
├── scripts/                                     # Workspace-wide shell scripts
│   ├── changed-workspaces.sh
│   ├── dev.sh
│   ├── lint-all.sh
│   ├── prepare.sh
│   └── typecheck-all.sh
│
├── .oxlintrc.json                               # Shared lint config (stays at root)
├── .oxfmtrc.json                                # Shared format config (stays at root)
├── oxlint-plugin-drizzle.js                     # Custom oxlint plugin (stays at root)
├── package.json                                 # Lean workspace root (no Next.js deps)
├── pnpm-workspace.yaml                          # Updated workspace globs
├── knip.ts                                      # Workspace-level knip config (if needed)
├── .github/workflows/                           # Updated path references
├── docs/ / plans/ / patches/ / prototypes/
├── .nvmrc / .npmrc / .gitignore / .prettierignore / etc.
└── ... (other repo-wide configs)
```

## Implementation Steps

### Phase 1: Create directory scaffolding

1. Create `apps/web/`, `apps/storybook/`, and `apps/mobile/` (empty)
2. Create `services/` (empty)

### Phase 2: Move the Next.js app to apps/web/

This is the highest-risk change. Everything below must happen atomically (single commit).

**Move directories:**

- `src/` -> `apps/web/src/`
- `public/` -> `apps/web/public/`
- `tests/` -> `apps/web/tests/`
- `dev/` -> `apps/web/dev/`

**Move Next.js-specific config files:**

- `next.config.mjs` -> `apps/web/next.config.mjs`
- `vercel.json` -> `apps/web/vercel.json`
- `postcss.config.mjs` -> `apps/web/postcss.config.mjs`
- `components.json` -> `apps/web/components.json`
- `instrumentation-client.ts` -> `apps/web/instrumentation-client.ts`
- `sentry.edge.config.ts` -> `apps/web/sentry.edge.config.ts`
- `sentry.server.config.ts` -> `apps/web/sentry.server.config.ts`
- `mdx-components.tsx` -> `apps/web/mdx-components.tsx`
- `.madgerc` -> `apps/web/.madgerc`
- `.dependency-cruiser.js` -> `apps/web/.dependency-cruiser.js`
- `.vercelignore` -> `apps/web/.vercelignore`
- `.env` -> `apps/web/.env`
- `.env.test` -> `apps/web/.env.test`
- `.env.development.local.example` -> `apps/web/.env.development.local.example`
- `skills-lock.json` -> `apps/web/skills-lock.json`

**Keep at workspace root (NOT moved):**

- `.oxlintrc.json` -- shared by all workspaces; 20+ packages reference it via `pnpm -w exec oxlint --config .oxlintrc.json`
- `.oxfmtrc.json` -- workspace-wide formatting config
- `oxlint-plugin-drizzle.js` -- loaded by `.oxlintrc.json`; must stay alongside it

**Move test configs:**

- `jest.config.ts` -> `apps/web/jest.config.ts`
- `playwright.config.ts` -> `apps/web/playwright.config.ts`

**Move tsconfigs:**

- `tsconfig.json` -> `apps/web/tsconfig.json`
- `tsconfig.scripts.json` -> `apps/web/tsconfig.scripts.json`

**Split package.json:**

- Create `apps/web/package.json` with:
  - `"name": "web"` (renamed from `kilocode-backend` -- the old name is misleading for a Next.js frontend app, and `web` is the conventional pnpm workspace name used by `--filter` commands throughout the plan)
  - All Next.js app `dependencies` and `devDependencies`
  - All Next.js-specific scripts (`dev`, `build`, `start`, `lint`, `format`, `test`, `test:e2e`, etc.)
- Update root `package.json` to be lean workspace root:
  - Keep `prepare` (husky), `preinstall` (only-allow pnpm)
  - Keep workspace-wide scripts (e.g., `typecheck` delegated to `scripts/typecheck-all.sh`)
  - Remove all Next.js deps
  - Keep `pnpm.patchedDependencies` at root -- the `@storybook/nextjs` patch is consumed by `apps/storybook/`, not `apps/web/`, and pnpm resolves patched dependencies at workspace scope
  - Keep `pnpm.overrides` that are workspace-wide

**Update `scripts/typecheck-all.sh`:** Replace all `kilocode-backend` references with `web` — the script hardcodes the package name in `--filter '!kilocode-backend'` exclusions (lines 47, 57, 89) and a name-match skip (line 78). Without this, the script will fail to exclude the web app from recursive workspace typechecks and may re-enter the root `typecheck` alias.

**Fix path references in moved configs:**

- `apps/web/tsconfig.json`:
  - `@kilocode/db` path: `./packages/db/src/index.ts` -> `../../packages/db/src/index.ts`
  - `@kilocode/encryption` path: similarly prefix with `../../`
  - `include` paths stay relative (still `src/**/*`, `tests/**/*`)
  - `.next/types/**/*.ts` stays relative

- `apps/web/tsconfig.scripts.json`:
  - Same `../../` prefix for package references

- `apps/web/jest.config.ts`:
  - `<rootDir>/packages/db/src/$1` -> `<rootDir>/../../packages/db/src/$1`
  - `testPathIgnorePatterns` that reference `<rootDir>/cloud-agent/` etc. -> update to `<rootDir>/../../services/` paths (with stripped `cloudflare-` prefix where applicable)

- `apps/web/playwright.config.ts`:
  - `testDir` stays `./tests/e2e` (since tests/ moves with the app)
  - webServer command may need updating

- `apps/web/.madgerc`: `baseDir: "."` stays correct

- `apps/web/.dependency-cruiser.js`: `tsConfig.fileName: 'tsconfig.json'` stays correct

- `apps/web/.prettierignore` -- if moved, update `src/` references (or this may stay at root)

### Phase 3: Move Storybook and kilo-app to apps/

**Storybook:**

- `storybook/` -> `apps/storybook/`
- Update any internal path references

**kilo-app (mobile):**

- `kilo-app/` -> `apps/mobile/`
- Update `kilo-app/package.json` lint script: the `pnpm -w exec oxlint --config kilo-app/.oxlintrc.json kilo-app/src` path becomes `pnpm -w exec oxlint --config apps/mobile/.oxlintrc.json apps/mobile/src`
- Update `kilo-app/AGENTS.md` references
- Update `kilo-app/app.config.js` if it has any path references
- Note: the package name stays `kilo-app` (no rename in this PR)

### Phase 4: Move workers to services/

Move each worker directory from the repo root to `services/`, stripping the `cloudflare-` prefix:

```
cloud-agent/                         -> services/cloud-agent/
cloud-agent-next/                    -> services/cloud-agent-next/
cloudflare-gastown/                  -> services/gastown/
cloudflare-deploy-infra/             -> services/deploy-infra/
cloudflare-code-review-infra/        -> services/code-review-infra/
cloudflare-auto-triage-infra/        -> services/auto-triage-infra/
cloudflare-auto-fix-infra/           -> services/auto-fix-infra/
cloudflare-app-builder/              -> services/app-builder/
cloudflare-ai-attribution/           -> services/ai-attribution/
cloudflare-db-proxy/                 -> services/db-proxy/
cloudflare-webhook-agent-ingest/     -> services/webhook-agent-ingest/
cloudflare-session-ingest/           -> services/session-ingest/
cloudflare-o11y/                     -> services/o11y/
cloudflare-git-token-service/        -> services/git-token-service/
cloudflare-security-sync/            -> services/security-sync/
cloudflare-security-auto-analysis/   -> services/security-auto-analysis/
cloudflare-gmail-push/               -> services/gmail-push/
cloudflare-images-mcp/               -> services/images-mcp/
kiloclaw/                            -> services/kiloclaw/
```

**Rewrite lint scripts in every moved workspace:**

Every service and package uses `pnpm -w exec oxlint --config .oxlintrc.json <workspace-root-relative-path>/src` for its `lint` script. After the move, these hardcoded paths must be updated. For example:

- `cloud-agent/package.json`: `cloud-agent/src` -> `services/cloud-agent/src`
- `cloudflare-db-proxy/package.json`: `cloudflare-db-proxy/src` -> `services/db-proxy/src`
- `kiloclaw/package.json`: `kiloclaw/src` -> `services/kiloclaw/src`
- Same for all other workers, `packages/db`, `packages/encryption`, `packages/worker-utils`

This also applies to `scripts/lint-all.sh` which hardcodes directory lists for oxlint.

Note: The underlying pattern of using `pnpm -w exec` with workspace-root-relative paths is fragile. A future improvement would be to make lint scripts relative to the package directory, but that is out of scope for the restructure.

### Phase 5: Move kiloclaw-secret-catalog to packages/

- `services/kiloclaw/packages/secret-catalog/` -> `packages/kiloclaw-secret-catalog/`
- Update the `package.json` if it has any relative path references

### Phase 6: Update pnpm-workspace.yaml

Replace the explicit list with globs + specific entries:

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

catalog:
  # ... (unchanged)
```

### Phase 7: Update GitHub Actions workflows

**ci.yml:**

- Update `dorny/paths-filter` paths: prefix all worker paths with `services/`
- Update `working-directory` for wrapper builds: `services/cloud-agent/wrapper`, `services/cloud-agent-next/wrapper`
- Update all worker directory references with stripped `cloudflare-` prefix
- Update `.next/cache` path: `${{ github.workspace }}/apps/web/.next/cache`
- Update Vercel commands to work from `apps/web/` directory
- Note: `pnpm --filter <name>` commands use package names, NOT paths -- worker and package names don't change, but the web app is renamed from `kilocode-backend` to `web` in Phase 2
- Add `--exclude apps/web` to the `changed-workspaces.sh` invocation (line 66) -- without this, the renamed `web` workspace will appear in `workspace_matrix` and duplicate the dedicated web test job

**deploy-production.yml:**

- Update `.next/cache` path (3 occurrences)
- Update `dorny/paths-filter` for kiloclaw: `services/kiloclaw/**`
- Update Vercel link/build/deploy to use correct working directory

**deploy-workers.yml:**

- Update `WORKERS` array: use new `services/` paths with stripped `cloudflare-` prefix
- Update `workflow_dispatch` choices: same new paths
- Update `working-directory` references
- Update `git diff` path detection

**deploy-kiloclaw.yml:**

- Update all `kiloclaw` -> `services/kiloclaw`
- Update Docker context and Dockerfile paths

**bump-openclaw.yml:**

- Update `kiloclaw/Dockerfile` -> `services/kiloclaw/Dockerfile`

**chromatic.yml:**

- Update storybook references: `storybook/` -> `apps/storybook/`

**kilo-app-ci.yml:**

- Update `kilo-app/` references -> `apps/mobile/`

**kilo-app-release.yml:**

- Update `kilo-app/` references -> `apps/mobile/`

### Phase 8: Create root package.json (lean workspace root)

The new root package.json should contain:

- `"name": "kilocode-monorepo"` (or similar)
- `"private": true`
- `"packageManager": "pnpm@10.27.0"`
- `"engines": { "node": "^22" }`
- `"scripts"`: workspace-wide scripts plus aliases for CI entrypoints:
  - `"prepare": "husky"`
  - `"preinstall": "npx only-allow pnpm"`
  - `"typecheck": "scripts/typecheck-all.sh"`
  - `"build": "pnpm --filter web build"`
  - `"test": "pnpm --filter web test"`
  - `"lint": "scripts/lint-all.sh"`
  - `"validate": "pnpm run typecheck && pnpm run lint && pnpm run test"`
  - `"drizzle": "pnpm --filter @kilocode/db exec drizzle-kit"` -- used by ci.yml (`pnpm drizzle check`) and deploy-production.yml / chromatic.yml (`pnpm drizzle migrate`)
  - `"test:e2e": "pnpm --filter web run test:e2e"` -- used by chromatic.yml
  - `"dependency-cycle-check": "pnpm --filter web run dependency-cycle-check"` -- used by ci.yml
- Minimal `devDependencies`: `husky`, shared tooling only
- Keep `pnpm.patchedDependencies` at root (includes `@storybook/nextjs` patch consumed by `apps/storybook/`)
- Keep `pnpm.overrides` at root
- Keep `scripts/` directory at root for workspace-wide shell scripts

**Important:** CI workflows call several root scripts directly (`pnpm drizzle check`, `pnpm drizzle migrate`, `pnpm test:e2e`, `pnpm run dependency-cycle-check`). These must either remain as root aliases that delegate to the correct workspace, or the workflows must be updated to use `pnpm --filter` commands. The alias approach is safer since it avoids simultaneous workflow changes.

### Phase 9: Fix .prettierignore and other repo-wide configs

- Update `.prettierignore` paths (`src/tests/sample` -> `apps/web/src/tests/sample`, etc.)
- Update `.gitignore` if it references `src/`-specific patterns
- Update `knip.ts` -- split into root-level (workspace-wide) and `apps/web/knip.ts` (app-specific)
- Decide whether `.oxfmtrc.json` stays at root (workspace-wide) or moves into `apps/web/`

### Phase 10: Verification

Run and fix:

1. `pnpm install` -- verify workspace resolution works
2. `pnpm typecheck` -- all packages compile
3. `pnpm --filter web build` -- Next.js build succeeds
4. `pnpm --filter web test` -- Jest tests pass
5. `pnpm --filter kilo-app typecheck` -- Mobile app compiles
6. Worker builds: spot-check a few with `pnpm --filter <name> typecheck`
7. Verify `pnpm -r lint` runs correctly
8. Verify `scripts/changed-workspaces.sh` still works (used in CI)

### Phase 11: External configuration (manual, post-merge)

These cannot be done in code and must be done manually:

- **Vercel dashboard**: Update "Root Directory" for `kilocode-app`, `kilocode-global-app`, and `kilocode-gateway` projects to `apps/web`
- **Sentry**: If Sentry source map upload references paths, update in Sentry project settings
- **EAS (Expo)**: If EAS Build references `kilo-app/` paths in project config, update to `apps/mobile/`

## Risks and Mitigations

| Risk                                          | Mitigation                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git history fragmentation from `git mv`       | Use `git mv` for all moves to preserve history tracking. Git is good at detecting renames.                                                                                        |
| Vercel deployment breaks                      | Update Vercel root directory setting IMMEDIATELY after merge. Consider coordinating merge timing.                                                                                 |
| pnpm resolution breaks                        | Run `pnpm install` after every structural change to catch issues early                                                                                                            |
| Import paths break                            | The `@/*` alias stays the same (relative to tsconfig). Cross-package `workspace:*` deps use package names, not paths.                                                             |
| CI workflows fail on first run                | Have the workflow updates in the same commit as the directory moves                                                                                                               |
| `.env` not found by Next.js                   | Next.js loads `.env` from its project root -- moving it to `apps/web/.env` is correct                                                                                             |
| EAS builds break for kilo-app                 | Coordinate with mobile team; update EAS config post-merge if needed                                                                                                               |
| `scripts/` shell scripts have hardcoded paths | Audit `scripts/*.sh` for workspace path assumptions (e.g., `changed-workspaces.sh` uses pnpm workspace paths that may change)                                                     |
| Lint scripts break across all workspaces      | Every workspace's `lint` script hardcodes its root-relative path. Rewrite all 20+ `package.json` lint entries and `scripts/lint-all.sh` in the same commit as the directory moves |
| Root CI entrypoints disappear                 | Keep root aliases (`drizzle`, `test:e2e`, `dependency-cycle-check`) that delegate to the correct workspace, so workflows don't need simultaneous updates                          |
| Merge conflict volume at execution time       | Execute the restructure on a fresh branch from main, not incrementally on a long-lived branch                                                                                     |
| `@kilocode/trpc` build ordering               | `scripts/typecheck-all.sh` conditionally rebuilds trpc before workspace typechecks. This ordering must be preserved.                                                              |
| `typecheck-all.sh` hardcoded package name     | The script excludes `kilocode-backend` in 4 places. Phase 2 renames this to `web` — both must be updated in the same commit.                                                      |

## Out of Scope (for future PRs)

- Turborepo adoption -- evaluate as optional local DX tooling (incremental typecheck caching, filtered builds) after the restructure lands, scripts are normalized, and duplicate workspace names are resolved. Should not replace root build/test/lint commands or CI job topology.
- Renaming worker packages to consistent `@kilocode/*` convention
- Migrating Jest -> Vitest for the Next.js app
- Unifying test frameworks across workers
- Extracting more shared code from `src/lib/` into `packages/`
- Resolving the duplicate `@kilocode/cloud-agent-wrapper` package name
- Renaming `kilo-app` package to `@kilocode/mobile` or similar
