# Kilo Code — Cloud

Monorepo for the Kilo Code cloud platform: the web app, Cloudflare Worker services, and shared packages.

## Repository structure

```
apps/
  web/            Next.js web application (Vercel)
  mobile/         React Native mobile app
  storybook/      Component playground
services/         Cloudflare Worker services (KiloClaw, Cloud Agent, etc.)
packages/         Shared libraries (db, trpc, worker-utils, etc.)
dev/              Local development tooling (tmux dashboard, docker-compose, env sync)
scripts/          CI and one-off scripts
```

## Getting started

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full local setup guide — prerequisites, database, environment variables, and common commands.

Quick start (assuming prerequisites are installed):

```bash
git clone git@github.com:Kilo-Org/cloud.git
cd cloud
nvm install && nvm use
pnpm install
vercel link --project kilocode-app && vercel env pull
docker compose -f dev/docker-compose.yml up -d
pnpm drizzle migrate
pnpm dev:start
```

## External resources

- [Vercel project](https://vercel.com/kilocode/kilocode-app)
- [Google Cloud OAuth](https://console.cloud.google.com/auth/clients?project=kilocode)
