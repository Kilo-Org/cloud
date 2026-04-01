# Contributing — macOS Local Development Setup

This guide walks you through setting up the Kilo Code backend for local development on macOS.

## Prerequisites

You need the following system-level tools installed before proceeding. If you already have any of these, skip the relevant step.

### Xcode Command Line Tools

```bash
xcode-select --install
```

### Homebrew

Install from https://brew.sh or from the [GitHub releases](https://github.com/Homebrew/brew/releases/).

If Homebrew isn't on your `PATH` yet:

```bash
echo 'export PATH=/opt/homebrew/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
```

### Git and Git LFS

```bash
brew install git git-lfs
git lfs install --skip-repo
```

The `--skip-repo` flag avoids conflicts with the project's Husky hooks. Git LFS is used for large binary files (videos).

### Node.js 22 (via nvm)

The project requires Node.js 22 (see `.nvmrc` and `package.json` `engines` field).

```bash
brew install nvm
mkdir -p ~/.nvm
```

Add the following to your `~/.zshrc`:

```bash
# nvm (Node Version Manager)
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && \. "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"
```

Then reload your shell and install Node 22:

```bash
source ~/.zshrc
nvm install 22
nvm use 22
```

### pnpm

The project uses [pnpm](https://pnpm.io/) as its package manager (version pinned in `package.json` `packageManager` field).

```bash
brew install pnpm
```

### Docker

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) either from the website or via Homebrew:

```bash
brew install --cask docker
```

**Important:** Open Docker Desktop at least once after installation — it configures the CLI tools needed for `docker compose`.

### Vercel CLI

Used to pull environment variables from the Vercel project:

```bash
pnpm add -g vercel
```

### Stripe CLI (optional, for payment testing)

```bash
brew install stripe/stripe-cli/stripe
```

## Project Setup

### 1. Clone the repository

```bash
git clone git@github.com:Kilo-Org/cloud.git
cd cloud
```

### 2. Install dependencies and pull LFS assets

```bash
nvm use 22
pnpm install
git lfs pull
```

### 3. Set up environment variables

The project pulls environment variables from Vercel. Run these commands interactively (each will prompt for browser-based authentication):

```bash
vercel login
vercel link --project kilocode-app
vercel env pull
```

This creates `.env.local` with all required environment variables.

### 4. Start the database

The project uses PostgreSQL 18 with pgvector, running via Docker. The compose file is at `dev/docker-compose.yml`:

```bash
docker compose -f dev/docker-compose.yml up -d
```

This starts a PostgreSQL container on port 5432 with:

- User: `postgres`
- Password: `postgres`
- Database: `postgres`

### 5. Run database migrations

```bash
pnpm drizzle migrate
```

You need to re-run this every time you pull new migrations from the repository.

### 6. Start the development server

```bash
pnpm dev
```

The app will be available at http://localhost:3000.

## Verifying Your Setup

Run the test suite to confirm everything is working:

```bash
pnpm test
```

All tests should pass against the local PostgreSQL database.

## Common Development Commands

| Command                 | Description                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Start the Next.js dev server (Turbopack)                                                          |
| `pnpm dev:start`        | Start all local services in a tmux dashboard                                                      |
| `pnpm dev:stop`         | Stop the tmux session and all services                                                            |
| `pnpm dev:env`          | Sync `.dev.vars` files from `.env.local` (see [Worker `.dev.vars` setup](#worker-dev-vars-setup)) |
| `pnpm test`             | Run the Jest test suite                                                                           |
| `pnpm typecheck`        | Run the TypeScript type checker                                                                   |
| `pnpm lint`             | Lint all source files                                                                             |
| `pnpm lint:changed`     | Lint only files changed since `main`                                                              |
| `pnpm format`           | Format all supported files with oxfmt                                                             |
| `pnpm format:changed`   | Format only files changed since `main`                                                            |
| `pnpm validate`         | Run typecheck, lint changed, format changed, tests, and dependency cycle check                    |
| `pnpm drizzle migrate`  | Apply pending database migrations                                                                 |
| `pnpm drizzle generate` | Generate a new migration after schema changes                                                     |
| `pnpm stripe`           | Start Stripe webhook forwarding to localhost                                                      |
| `pnpm test:e2e`         | Run Playwright end-to-end tests                                                                   |

## Git Workflow

- Direct commits to `main` are blocked by a git hook. Always work on a feature branch.
- The pre-push hook runs `pnpm format:check`, `pnpm lint`, and `pnpm typecheck`.

## Stripe Webhook Testing

To test Stripe integration locally:

1. Log in to Stripe CLI: `stripe login`
2. Start the webhook forwarder: `pnpm stripe`
3. Copy the webhook signing secret from the CLI output
4. Add it to `.env.development.local`:
   ```
   STRIPE_WEBHOOK_SECRET="whsec_..."
   ```

## Database Schema Changes

1. Edit the schema in `src/db/schema.ts`
2. Generate a migration: `pnpm drizzle generate`
3. Apply it: `pnpm drizzle migrate`

## Nix Alternative

If you prefer [Nix](https://nixos.org/), the project includes a `flake.nix` with a dev shell that provides all required tools. With [direnv](https://direnv.net/) installed, the `.envrc` file will automatically activate the Nix environment when you enter the project directory.

## Fake Login (Local Authentication)

In local development, you can sign in without real OAuth by navigating to:

```
http://localhost:3000/users/sign_in?fakeUser=<email>
```

This creates a local-only user with the `@@fake@@` hosted domain. You can append `callbackPath` to go directly to a page after login:

```
http://localhost:3000/users/sign_in?fakeUser=someone@example.com&callbackPath=/profile
```

### Admin access

Some features (e.g., admin panels) are only visible to users with `is_admin = true`. The admin flag is set at user-creation time based on the email address:

- **Real OAuth:** emails ending in `@kilocode.ai` with the `kilocode.ai` hosted domain are admins.
- **Fake login:** emails must end in `@admin.example.com` to get admin access.

To sign in as a fake admin:

```
http://localhost:3000/users/sign_in?fakeUser=yourname@admin.example.com
```

A non-`@admin.example.com` email (e.g., `someone@kilocode.ai`) used via fake login will **not** be an admin, because the fake-login provider sets `hosted_domain` to `@@fake@@`, not `kilocode.ai`.

## Organizations & Enterprise Trials

New organizations start with a 30-day enterprise trial. After expiry, the UI progressively locks down: first a soft lock (read-only with dismiss option), then a hard lock (no access without subscribing). This can be inconvenient in local development.

### Using the built-in dev organization

The easiest approach is to use the pre-configured dev organization. While signed in, run the following in the browser console (the endpoint is POST-only):

```js
fetch('http://localhost:3000/api/dev/create-kilocode-org', { method: 'POST' })
  .then(r => r.json())
  .then(console.log);
```

This creates a "Kilocode Local" org (`id: 00000000-0000-0000-0000-000000000000`) with:

- `plan: 'enterprise'`
- `require_seats: false` — bypasses all trial/subscription checks
- `free_trial_end_at: '9999-12-31'` — effectively never expires

### Making any organization never expire

If you've already created an organization and want to prevent its trial from expiring, you have two options:

**Option A: Set `require_seats` to `false` in the database**

This is the most reliable bypass — it short-circuits all trial enforcement (server-side middleware, client-side UI, and login redirects):

```sql
UPDATE organizations SET require_seats = false WHERE id = '<your-org-id>';
```

**Option B: Use the admin panel**

1. Sign in as a fake admin (`yourname@admin.example.com`)
2. Open the admin panel from the account dropdown in the top-right corner
3. Find your organization and either:
   - Set `free_trial_end_at` to a far-future date
   - Toggle on `suppress_trial_messaging` (hides all trial UI)

### How trial enforcement works

Trial status is checked at three layers:

| Layer          | Mechanism                                                                         | Bypassed by `require_seats = false` |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| tRPC mutations | `requireActiveSubscriptionOrTrial()` middleware throws `FORBIDDEN` on hard expiry | Yes                                 |
| Login redirect | `isOrganizationHardLocked()` redirects to `/profile`                              | Yes                                 |
| Client UI      | `OrganizationTrialWrapper` shows banners and lock dialogs                         | Yes                                 |

### Test organizations with various trial states

A script creates 6 organizations with different trial states for UI testing:

```bash
pnpm script:run db create-trial-test-orgs yourname@admin.example.com
```

## Cloudflare Workers & AI Inference

The application consists of the Next.js app plus several Cloudflare Worker services (see `pnpm-workspace.yaml`). In local development, most day-to-day work only requires the Next.js app and PostgreSQL — workers are started individually as needed.

### AI / model inference

AI inference works locally without any extra services. The Next.js app includes an OpenRouter proxy route (`/api/openrouter/[...path]`) that calls real AI providers using API keys from `.env.local`. There are no mocks or local stubs — all inference hits real APIs (OpenRouter, OpenAI, Anthropic, Mistral, etc.).

### Running workers locally

Each worker in the workspace can be started individually with `wrangler dev` (or `pnpm dev`) from its directory. Workers communicate with Next.js over HTTP using env vars like `CLOUD_AGENT_API_URL`, `CODE_REVIEW_WORKER_URL`, etc. Dev ports are defined in each worker's `wrangler.jsonc`.

The easiest way to run workers is with `pnpm dev:start` (see [Common Development Commands](#common-development-commands)), which starts groups of related services in a tmux dashboard.

### Worker `.dev.vars` setup

Most workers require a `.dev.vars` file with secrets like `NEXTAUTH_SECRET` and `INTERNAL_API_SECRET`. A script automates this:

```bash
pnpm dev:env
```

The script (`dev/local/env-sync/`) scans every `.dev.vars.example` in the repo, resolves each variable's value, and writes (or patches) the corresponding `.dev.vars` file. Before applying, it shows a diff of what will change and asks for confirmation.

Values are resolved using annotations in `.dev.vars.example` comment lines:

| Annotation         | What it does                                                                       | Example                                   |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| _(none)_           | Copies the value from `.env.local` if the key matches, otherwise keeps the default | `INTERNAL_API_SECRET=your-secret-here`    |
| `# @url <service>` | Builds `http://localhost:<port>` from the service's dev port in `wrangler.jsonc`   | `# @url nextjs` → `http://localhost:3000` |
| `# @from <KEY>`    | Copies the value of a _different_ key from `.env.local`                            | `# @from CODE_REVIEW_WORKER_AUTH_TOKEN`   |
| `# @pkcs8`         | Copies from `.env.local` and converts PKCS#1 PEM keys to PKCS#8 format             | `# @pkcs8` above a private key var        |

For example, in a `.dev.vars.example`:

```bash
# @url nextjs
API_URL=http://localhost:3000

# @from CODE_REVIEW_WORKER_AUTH_TOKEN
BACKEND_AUTH_TOKEN=your-backend-auth-token
```

The `@url` annotation accepts multiple comma-separated services (e.g., `# @url svc-a,svc-b`) and appends path suffixes (e.g., `# @url nextjs/api/events`).

Run `pnpm dev:env` again after pulling changes that add new env vars to any `.dev.vars.example`.

### Limitations in local dev

- **Service bindings** between workers don't function in local `wrangler dev`. This affects chains like session-ingest → o11y, webhook-agent → cloud-agent, and app-builder → db-proxy/git-token-service.
- **Cloudflare Containers** (used by cloud-agent, cloud-agent-next, app-builder) always run on Cloudflare's remote infrastructure, even in dev mode. Purely local execution is not possible.
- **Cloudflare-specific features** like Analytics Engine, Pipelines, and dispatch namespaces don't work locally.

### What works without running any workers

The core Next.js app handles profiles, organizations, usage tracking, billing, and the OpenRouter inference proxy without any workers. Features that require a specific worker (e.g., Cloud Agent sessions, code reviews, app builder) will fail gracefully or show connection errors if that worker isn't running.

### Multi-worktree support

If you use `git worktree` to run multiple checkouts simultaneously, set the `KILO_PORT_OFFSET` environment variable to avoid port collisions between worktrees:

```bash
# Automatic offset derived from the worktree directory name (0 for the primary worktree):
export KILO_PORT_OFFSET=auto

# Or a fixed numeric offset (added to every service port):
export KILO_PORT_OFFSET=100
```

With `auto`, the primary worktree gets offset 0 (default ports), and secondary worktrees get a deterministic offset based on the directory name. The offset is added to the Next.js port (3000), all worker dev ports, and the URLs generated by `pnpm dev:env`.

## Troubleshooting

### Node version mismatch

If you see errors about unsupported Node.js versions, ensure you're using Node 22:

```bash
nvm use 22
node --version  # Should output v22.x.x
```

### Database connection errors

Make sure the PostgreSQL container is running:

```bash
docker compose -f dev/docker-compose.yml up -d
docker ps | grep postgres
```

The connection string used by the app is `postgres://postgres:postgres@localhost:5432/postgres`.

### Missing `.env.local`

The dev server won't start without environment variables. Run `vercel env pull` to create `.env.local`. If you don't have Vercel access yet, ask a team member for help.

### `pnpm install` fails with engine mismatch

This means your active Node.js version doesn't match the `engines` field in `package.json`. Switch to Node 22 with `nvm use 22`.

### Git LFS files show as pointer files

If image/video files appear as small text files with `oid sha256:...`, run:

```bash
git lfs pull
```
