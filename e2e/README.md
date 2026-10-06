# Kilo Cloud E2E

Playwright UI tests for `apps/web`, built on `@anaconda/playwright-utils`. The legacy tests in
`apps/web/tests/e2e/` move here spec by spec; until a spec is migrated, it keeps running from there.

## Why this folder is separate

`@anaconda/playwright-utils` is a private package on GitHub Packages, and this repo is public. So
`e2e/` is its own package outside the pnpm workspace, with its own lockfile: the root install never
needs the private registry. Root `oxlint`/`oxfmt` skip `e2e/`; it uses the ESLint and Prettier
config from `@anaconda/playwright-utils`.

## Install

Requires Node 24 and a GitHub token with `read:packages` (`gh auth refresh -h github.com -s read:packages`).
Pass the token as an env var only; `.npmrc` reads it from `NODE_AUTH_TOKEN`.

```
NODE_AUTH_TOKEN=$(gh auth token) pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm exec playwright install chromium
```

`--ignore-scripts` skips the package's postinstall, which only downloads Chromium.

## Run

Start the app from the repo root (`pnpm dev:start`), then from `e2e/`:

| Script | Purpose |
|---|---|
| `pnpm test` | Run all tests |
| `pnpm test:smoke` / `pnpm test:reg` | Only `@smoke` / `@reg` tests |
| `pnpm report` | Open the last HTML report |
| `pnpm validate` / `pnpm lint` / `pnpm format` | Type check, ESLint, Prettier |
| `pnpm check:code-quality` | playwright-utils quality checks |

`URL` overrides the base URL (default `http://localhost:3000`) and `POSTGRES_URL` the database used
for seeding (default: the local docker Postgres).

## CI

`.github/workflows/e2e.yml` runs on pull requests and the merge queue. It is not a required check, and
it skips fork PRs, which get no secrets. The job starts Postgres, runs migrations, installs `e2e/`
with the `ANACONDA_PACKAGES_READ_TOKEN` secret (on that step only), starts `next dev` with
`ci/start-web.mjs`, compiles the tested routes with `ci/warm-up.mjs`, and runs `pnpm test`. The
report, failure traces and the server log are uploaded as the `e2e-report` artifact for 7 days.

To reproduce it locally: stop `pnpm dev:start`, run `node e2e/ci/start-web.mjs` and
`node e2e/ci/warm-up.mjs` from the repo root, then `CI=1 pnpm test` in `e2e/`.

## Layout

```
tests/
  specs/ui/<product>/          # specs
  pages/{ui,api}/<product>/    # page objects (UI) and API helpers
  fixtures/fixture.ts          # registers every page object; specs import `test` from here
  support/core/                # database seeding, hydration wait
  testdata/ui/<product>/       # paths, labels and other test data
```

Each test seeds its own user with plain SQL and signs in through the dev-only fake login, so nothing
depends on shared dev data.
