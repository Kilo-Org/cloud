# Contributing to Kilo Code Cloud

See [the Documentation for details on contributing](https://kilo.ai/docs/contributing).

## TL;DR

There are lots of ways to contribute to the project:

- **Code Contributions:** Implement new features or fix bugs
- **Documentation:** Improve existing docs or create new guides
- **Bug Reports:** Report issues you encounter
- **Feature Requests:** Suggest new features or improvements
- **Community Support:** Help other users in the community

The Kilo Community is [on Discord](https://kilo.ai/discord).

## Prerequisites

- **Node.js 24** (`.nvmrc` pins `24.14.1`) — required for all packages.
- **pnpm 11.1.2** — use Corepack so the active version matches `package.json` `packageManager`:
  ```bash
  corepack enable
  corepack prepare pnpm@11.1.2 --activate
  ```
- **Docker / Docker Compose** — required to run the local PostgreSQL database.

## Developing Kilo Code Cloud

### 1. Install dependencies

```bash
nvm install && nvm use
pnpm install
```

### 2. Set up environment variables

Run the interactive setup CLI to bootstrap `.env.local` from the example:

```bash
pnpm dev:setup-env
```

This prompts for the 8 required env vars only, generates secrets automatically where appropriate, then writes `.env.local`. If you already have a `.env.local` (e.g., from Vercel pull or a previous setup), the CLI warns you before overwriting anything.

After it completes, run:

```bash
pnpm dev:env
```

For the full list of environment variables, see [ENVIRONMENT.md](./ENVIRONMENT.md).

### 3. Start the database

```bash
docker compose -f dev/docker-compose.yml up -d
```

This starts PostgreSQL on `localhost:5432` with user `postgres` / password `postgres`.

### 4. Run database migrations

```bash
pnpm drizzle migrate
```

Re-run this after pulling new migrations. To fully reset:

```bash
pnpm dev:db:reset
pnpm drizzle migrate
```

To smoke-test migrations from a fresh database:

```bash
pnpm drizzle:verify-bootstrap
```

### 5. Start the development server

```bash
pnpm dev:start
```

This launches a tmux dashboard with the Next.js app and local infrastructure. The web app is available at http://localhost:3000.

To stop all services:

```bash
pnpm dev:stop
```

## Verifying Your Setup

```bash
pnpm test
```

All tests should pass against the local PostgreSQL database.

## Repo Layout

Key locations:

- `apps/web/` — Next.js web application and main UI code
- `apps/mobile/` — React Native mobile app
- `services/` — Cloudflare Worker services (KiloClaw, cloud agent, etc.)
- `packages/` — shared libraries (`@kilocode/db`, `@kilocode/trpc`, `@kilocode/worker-utils`)
- `dev/` — local dev tooling (docker-compose, tmux scripts, env sync, seed data)
- `scripts/` — CI and one-off scripts
- `packages/db/src/schema.ts` — database schema; migrations in `packages/db/src/migrations/`
- `apps/web/src/routers/` — tRPC routers

## Mock / seed data

The repo includes a seed runner for creating local fixtures via `pnpm dev:seed`. Run it with no args to see all available topics.

### App

- `pnpm dev:seed app:create-user <name> <email>` — creates a `kilocode_users` row with a real Stripe test customer, pre-bypassing onboarding gates so you can use the app immediately.
- `pnpm dev:seed app:add-credits <user-id> <usd>` — grants credits to an existing user, updating the `total_microdollars_acquired` balance and creating a `credit_transactions` row. Supports `--paid`/`--free`, `--category`, `--expires-in-days`, etc. Useful for testing billing and credit flows without manual DB edits.

### KiloClaw

- `pnpm dev:seed kiloclaw:fake-instance <user-id> [options]` — creates a fake personal KiloClaw instance + subscription in the database only (no real container or Worker). Before creating, it retires any prior fake personal instances for that user. Supports `--plan=trial|standard|commit` and `--days=<n>`. For paid plans, it also grants enough credits to cover the plan cost and then deducts the subscription cost.
- `pnpm dev:seed kiloclaw:fake-org-instance <user-id> <org-id> [options]` — same as above, but creates an instance belonging to an organization rather than a personal account.
- `pnpm dev:seed kiloclaw:referrals-<scenario>` — seeds KiloClaw referral fixtures. Topics include `referrals-happy-path`, `referrals-pending-referrer`, `referrals-cap-boundary`, and `referrals-support-override`.
- `pnpm dev:seed kiloclaw-billing:inactive-trials` — seeds inactive-trial billing fixtures. One user is provisioned through the real KiloClaw worker endpoint (`/api/platform/provision`), while others are DB-only rows representing users in recently-started, support-marked, or eligible inactive-trial states.

## Common Development Commands

| Command | Description |
|---|---|
| `pnpm dev:start` | Start all local services in a tmux dashboard |
| `pnpm dev:stop` | Stop the tmux session and all services |
| `pnpm dev:status` | Live status of running services |
| `pnpm dev:restart` | Restart a running service |
| `pnpm dev:env` | Sync `.dev.vars` files from `.env.local` |
| `pnpm test` | Run the Jest test suite |
| `pnpm test:e2e` | Run Playwright end-to-end tests |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm lint` | Lint all source files |
| `pnpm format` | Auto-format all supported files with oxfmt |
| `pnpm validate` | Run typecheck, lint, and tests together |
| `pnpm drizzle migrate` | Apply pending database migrations |
| `pnpm drizzle generate` | Generate a new migration after schema changes |

## Tests for a specific package

```bash
pnpm --filter <package> test
```

## Cloudflare Workers

Workers are started individually as needed:

```bash
cd services/<worker-name>
pnpm dev        # or: wrangler dev
```

Use `pnpm dev:start <group>` to run groups of related services via the tmux dashboard. The easiest way to manage workers during development is through the dev dashboard.

## Fake Login (Local Auth)

Sign in without real OAuth:

```
http://localhost:3000/users/sign_in?fakeUser=<email>
```

Use an `@admin.example.com` email for fake admin access:

```
http://localhost:3000/users/sign_in?fakeUser=<email>@admin.example.com
```

Append `callbackPath` to redirect after login:

```
http://localhost:3000/users/sign_in?fakeUser=<email>&callbackPath=/profile
```

## Git Workflow

- Direct commits to `main` are blocked. Always work on a feature branch.
- The pre-push hook runs `pnpm format:check`, `pnpm lint`, and `pnpm typecheck --changes-only`.

## Pull Requests

### PR Titles

Use conventional commit style PR titles:

- `feat: add MCP settings tab`
- `fix: correct Windows path handling`
- `docs: clarify issue template requirements`
- `chore: bump TypeScript version`
- `refactor: extract diff renderer into a hook`
- `test: cover ServerManager orphan cleanup`

### Contribution Ownership and AI Assistance

AI and coding agents are allowed, but contributors own the work they submit. Before requesting review, make sure you personally understand the change, have tested it appropriately, can explain the diff, and understand how it interacts with the affected packages and the rest of the repo.

Maintainers may close PRs that appear to be submitted without credible contributor ownership or understanding, including AI-assisted work that the contributor cannot explain or has not meaningfully reviewed.

### Tracker Use and Automation

Do not submit batches of agent-generated, untested, or weakly reviewed PRs.

Please keep concurrent PRs focused and limited. As a rule, open no more than three PRs at a time, especially if you are a new contributor. Prioritize high-impact or high-priority issues first instead of opening many speculative fixes. If a contributor opens a large batch of low-value or duplicative PRs, maintainers may close the batch and ask the contributor to choose one PR to reopen, focus, and bring up to the documented review bar before submitting more.

For issues, do not mass-create tickets through automation or agents. Search existing issues first, open issues only when you have enough context for someone to act, and prioritize the most important reports instead of filing every possible finding. Maintainers may close duplicate, low-signal, automated, or weakly reviewed issues without action.

Repeated disregard of this contribution guide, or high-volume automated or agent-generated tracker spam across issues or PRs, may result in maintainers blocking the responsible account.
