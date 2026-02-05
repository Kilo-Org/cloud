# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Project Overview

Cloudflare Worker that powers Kilocode Cloud Agents. It exposes a tRPC API for session preparation and execution, streams output over WebSockets, and runs the Kilocode CLI inside Cloudflare Sandbox containers. Durable Objects track sessions; Hyperdrive is used for Postgres lookups (for example, GitHub App installation IDs). The wrapper in `wrapper/` is a core component that brokers Kilocode CLI events into the worker’s `/ingest` WebSocket and handles job lifecycle.

## Development Commands

### Package Management

- Use pnpm (enforced by preinstall). Never use npm or yarn.
- `pnpm install` - Install dependencies

### Wrapper Build

- `pnpm run build:wrapper` - Build wrapper bundle (uses Bun in `wrapper/`)

### Testing

- `pnpm run test` - Unit tests (Vitest Node)
- `pnpm run test:integration` - Integration tests in Workers runtime (Miniflare)
- `pnpm run test:all` - Unit + integration

### Code Quality

- `pnpm run lint` - ESLint
- `pnpm run lint:fix` - ESLint with auto-fix
- `pnpm run format` - Prettier write (src only)
- `pnpm run format:check` - Prettier check (src only)
- `pnpm run typecheck` - TypeScript (tsgo) + wrapper typecheck

### Deployment

- DO NOT attempt to deploy directly. Always defer to the user.

## Architecture Overview

### Core Worker

- `src/index.ts` - Entry point, request routing
- `src/router/` - tRPC router and handlers
- `src/session-service.ts` - Session lifecycle orchestration
- `src/workspace.ts` - Workspace setup and git operations
- `src/streaming.ts` - WebSocket streaming

### Durable Objects

- `src/persistence/CloudAgentSession.ts` - Session DO storage + lifecycle
- `src/db/` - SQLite table definitions and store helpers for DOs

### Sandbox + Execution

- `src/execution/` - Orchestrator and execution lifecycle
- `src/kilo/` - Kilocode CLI wrapper client and helpers
- `Dockerfile` - Production sandbox image
- `Dockerfile.dev` - Dev sandbox image (local Kilocode CLI)
- `cloud-agent-build.sh` - Builds local Kilocode CLI binary for `Dockerfile.dev`

### Wrapper

- `wrapper/` - Local wrapper bundled into the sandbox image
- `wrapper/src/main.ts` - Wrapper entrypoint
- `src/shared/kilo-types.ts` - Types are a subset copied from `~/kilo/packages/sdk/js/src/v2/gen/types.gen.ts` (kilo repo, generated SDK); keep in sync when wrapper/Kilo API changes

### Configuration

- `wrangler.jsonc` - Worker config, bindings, environments
- `.dev.vars.example` - Local dev env template
- `worker-configuration.d.ts` - Auto-generated types. Do not edit; regenerate with `pnpm run types`.

## Environment Variables

Agents should NOT add environment variables with top-level validation that throws errors, like:

```ts
if (!process.env.ENV_VAR) {
  throw new Error('ENV_VAR is required');
}
```

This pattern blocks API endpoints from running for external contributors who don't have all environment variables configured. Instead, handle missing environment variables gracefully at the point of use, or make features degrade gracefully when optional env vars are missing.

## Development Guidelines

### Code Style

- Keep streaming payloads and schemas aligned with `src/shared/protocol.ts`

### Runtime Guidelines

- Durable Object calls should be retried using `withDoRetry` in `src/utils/do-retry.ts`
- Execute commands inside a session context (use `session.exec(...)`, not `sandbox.exec(...)`)

### Testing Standards

- Unit tests: `src/**/*.test.ts` (Vitest Node)
- Integration tests: `test/**/*.test.ts` (Workers runtime)
- Use `vitest.workers.config.ts` for Workers runtime tests

### Git Workflow

- Create feature branches; do not commit on main

## Key Locations

- `src/router/handlers/` - API endpoints (prepare, initiate, sendMessage, session management)
- `src/persistence/` - Durable Object schema + migrations
- `src/websocket/` - WebSocket ingest + filters
- `src/utils/` - Shared helpers (encryption, retries, SQL helpers)
- `wrangler.jsonc` - Bindings: R2, Hyperdrive, KV, queues, containers
- `vitest.config.ts` - Unit test config
- `vitest.workers.config.ts` - Integration test config
- `wrapper/` - Wrapper build shipped into the sandbox
