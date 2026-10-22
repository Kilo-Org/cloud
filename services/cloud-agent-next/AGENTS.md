# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Project Overview

Cloudflare Worker that powers Kilocode Cloud Agents. It exposes tRPC APIs for creating sessions and sending messages, streams output over WebSockets, and orchestrates sandboxes through the control plane.

Every session is a `workspace_*` control-plane session. The Session DO (`SandboxSessionV2`, exported as `SandboxSession`) owns message, route and event state. The Sandbox DO (`SandboxControlV2`, exported as `SandboxControl`) owns allocations, provider lifecycle and wrapper connections. The wrapper in `wrapper/src/control-plane/` runs inside the sandbox and supervises Kilo. The retired `agent_*` plane has no code path and old session IDs are rejected.

The Durable Objects are durable coordinators: they queue messages when a sandbox or wrapper is not ready, persist metadata and event replay state, schedule alarms, prepare or restore sandboxes, and deliver work to the wrapper. Most product behavior after the sandbox is available belongs on the wrapper/Kilo side. Keep the DOs focused on coordination, not feature logic.

Git tokens (GitHub App installation tokens, managed GitLab tokens) are resolved via the shared `git-token-service` Worker. The wrapper connects to the Sandbox DO, forwards Kilo events through it to the Session DO, and owns the job lifecycle inside the sandbox.

## Development Commands

### Package Management

- Use pnpm (enforced by preinstall). Never use npm or yarn.
- `pnpm install` - Install dependencies

### Wrapper Build

- `pnpm run build:wrapper` - Build wrapper bundle (uses Bun in `wrapper/`)

### Testing

- `pnpm run test` - Unit tests (Vitest Node)
- `pnpm run test:integration` - Integration tests in Workers runtime (Miniflare)
- `pnpm run test:fake-llm` - Fake-LLM Worker + Durable Object tests in Miniflare (`vitest.fake-llm.config.ts`)
- `pnpm run typecheck:fake-llm` - Typecheck for the fake LLM implementation and its Worker test
- `pnpm run test:all` - Unit + integration

### Local fake-LLM smoke harness

- `services/cloud-agent-next/test/e2e/README.md` is the source of truth for setup, fake-LLM routing, lifecycle directives, and troubleshooting.
- The deterministic fake has one runtime-neutral core (`test/e2e/fake-llm-core.ts`) with two adapters: the local Node server (`test/e2e/fake-llm-server.ts`) and the deployed Worker + `FakeLlmState` Durable Object (`test/e2e/fake-llm-worker.ts`, `test/e2e/wrangler.fake-llm.jsonc`). Change the core, not one adapter.
- Every `/test/*` route needs the admin bearer from `FAKE_LLM_ADMIN_TOKEN` (`test/e2e/fake-llm-admin.ts`). A zero-config local stack falls back to an insecure development default; the public tunnel refuses to publish it and the deploy script rejects it. The deployed profile resolves the bearer env-first and then from the auth file's `fakeLlmAdminToken`, exports the resolved value into `FAKE_LLM_ADMIN_TOKEN` for the run, and never prints it.
- The deployed Worker additionally authenticates its model routes with a Kilo JWT against the `NEXTAUTH_SECRET` Secrets Store binding. The local Node adapter keeps those routes open for the Next.js gateway.
- Driven and deployed by `test/e2e/deploy/README.md`; deployment is operator-driven. Do not deploy.
- Prefer focused scenario debugging first: `pnpm exec tsx services/cloud-agent-next/test/e2e/run.ts <lifecycle> <conversation>`.
- Run the aggregate local regression matrix with `pnpm --filter cloud-agent-next run e2e:local` (`test/e2e/matrix.ts`, one runner for the local, local-http and deployed profiles) when validating the full real Worker + DO + sandbox + wrapper path. The shared gate stops each scenario's sandboxes when it finishes, so live sandboxes track the pool size.
- Leave `KILO_OPENROUTER_BASE` on Next.js. Selecting `kilo/fake-deterministic` routes through the gateway to fake-llm; no `.dev.vars` flip.
- Non-zero `portOffset` sessions (the common case) require `WORKER_URL`/`FAKE_LLM_URL` env overrides on every driver invocation — see README "Running". Discover the offset with `pnpm dev:status --json`.
- This harness is local/manual rather than part of normal `pnpm test` or CI; use `dev/logs/cloud-agent-next.log` and `dev/logs/fake-llm.log` when debugging it.
- Read `services/cloud-agent-next/DEBUG.md` when correlating local Wrangler logs with Docker sandbox containers, wrapper log files, Kilo CLI logs, uploaded archives, or stuck session flows.

### Code Quality

- `pnpm run lint` - oxlint
- `pnpm run format` - oxfmt write (src only)
- `pnpm run format:check` - oxfmt check (src only)
- `pnpm run typecheck` - TypeScript (tsgo) + wrapper typecheck
- `pnpm run test:checkers` - Duplication checker fixtures
- `pnpm run check:duplication` - Production duplicate-code ratchet

### Deployment

- DO NOT attempt to deploy directly. Always defer to the user.

## Architecture Overview

### Core Worker

- `src/index.ts` - Worker exports, including `SandboxSession` and `SandboxControl`
- `src/server.ts` - Hono entry: tRPC, `/stream`, terminals, preview, callbacks
- `src/router.ts` - Router composition
- `src/router/handlers/session-start.ts` - Primary `start` endpoint
- `src/router/handlers/session-send.ts` - Primary `send` endpoint
- `src/router/handlers/session-prepare.ts` - Retained split `prepareSession`/`updateSession` adapters
- `src/router/handlers/session-execution.ts` - Retained split `initiateFromKilocodeSessionV2`/`sendMessageV2` adapters
- `src/session/` - Session requests, preflight, admission, metadata and queue helpers
- `src/workspace.ts` - Workspace setup and git operations
- `src/websocket/stream.ts` - Client-facing WebSocket stream
- `src/sandbox-session/` - Session DO transport, ingest and report helpers

### Durable Objects

- `src/control-plane/session/session-do.ts` - Session DO
- `src/control-plane/sandbox/sandbox-do.ts` - Sandbox DO
- `src/control-plane/*/sqlite-schema.ts` and `src/control-plane/*/drizzle/` - DO SQLite schemas and migrations
- `src/persistence/StreamTicketNonceDO.ts` - Stream-ticket replay nonce

### Sandbox + Execution

- `src/sandbox-control/` - Provider adapters, credentials, startup, runtime artifacts and wrapper transport
- `src/sandbox-containers/` - `SandboxContainers` provider and container outbound handling
- `src/agent-sandbox/` - Provider protocol and provider REST clients
- `Dockerfile`, `Dockerfile.containers*` - Sandbox images
- `Dockerfile.dev` - Dev sandbox image (local Kilocode CLI)
- `cloud-agent-build.sh` - Builds the local Kilocode CLI binary for `Dockerfile.dev`

### Wrapper

- `wrapper/` - Wrapper runtime bundled into the sandbox image
- `wrapper/src/control-plane/main.ts` - Wrapper entrypoint
- `wrapper/control-plane-supervisor.sh` - Container supervisor
- `wrapper/src/control-plane/session-supervisor.ts` - Per-process Kilo supervision and execution clocks
- `wrapper/src/control/` - Operations, terminals and worktree helpers

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
- Prefer grouped domain structures for new internals. Do not introduce new flat shared request or metadata shapes.

### Cloud Agent Architecture

`docs/control-plane.md` is the spec. Every session is a `workspace_*` control-plane session. The Worker exports `SandboxSessionV2` as `SandboxSession` and `SandboxControlV2` as `SandboxControl`. Implementation is `src/control-plane/session/`, `src/control-plane/sandbox/`, and `wrapper/src/control-plane/`. The split `prepareSession`/`initiateFromKilocodeSessionV2`/`sendMessageV2` endpoints are public compatibility adapters over the same Session DO, not a separate runtime.

- One state value per message, route, and allocation. Do not add a flag, proof, or counter that encodes a state the spec already names.
- The wrapper socket is the liveness signal. A close, or 45 seconds without a heartbeat, moves the allocation to `disconnected`. It then stops at the earlier of the reconnect window and the idle deadline (`connection_lost` or `sandbox_stopped`), and the next message prepares a new sandbox. Do not add a provider poll for a killed container. `sandbox_lost` is not that case: a confirmed provider stop during worktree deletion, or a Vercel network-policy failure on session release.
- A failure the user can hit has a specific reason. A new message or Stop starts recovery. Do not leave a session waiting on a condition the system already knows.
- Every native Kilo execution, including autonomous and unrouted work, is supervised per process by `wrapper/src/control-plane/session-supervisor.ts`. After 20 minutes without real assistant/tool progress it fails `no_progress`, including silent running tools; user waits pause only that clock. If Kilo was retrying the model request since the last progress, the stall fails as that retried assistant failure (for example a rate limit), not as a platform `no_progress`. The separate 120-minute wall-clock cap fails `execution_limit`; a `superseded` turn-close (Kilo handing off to a queued follow-up) continues the same execution, so follow-ups do not restart either clock. Descendant progress benefits ancestors, never unrelated roots. Runtime supervisors own compute activity, snapshots and bounded interruption; `turn.ts` owns Cloud message delivery, finalization and outcomes and must not regain a native watchdog. Pending delivery is separately bounded. An expired native execution is not re-dispatched.
- Treat `messageId` as the durable user-message identity. Queued/accepted admission may replay idempotently, but completed/failed/interrupted IDs are final and must not be re-admitted. The split responses keep `executionId` only as a compatibility alias.
- The split public endpoints accept flat input; handlers adapt it at the boundary into grouped `SessionCreateRequest` or queue input.
- New session metadata writes must use grouped `SessionMetadata` with `metadataSchemaVersion: 2`.
- Legacy flat metadata reads are allowed only inside `src/persistence/session-metadata.ts` via `parseSessionMetadata`. Application code should consume current grouped metadata only.
- Grouped `start` sends its already accepted canonical initial turn through `createSessionWithInitialAdmission`; retries must preserve the stored immutable intent and complete queue event/drain side effects without duplicate queue events. The retained prepared-session adapter reconstructs stored initial turns before admission.
- Callback delivery retry policy is paired with `wrangler.jsonc`: `CALLBACK_DELIVERY_MAX_ATTEMPTS` includes the initial attempt, and each Cloud Agent Next callback queue consumer must configure `max_retries` for the remaining redeliveries.
- Session creation preflight selects an explicit `ProfileResolutionPolicy`. Implicit repository/default profile resolution is limited to the closed set of approved session origins; omitted, unknown, and non-approved automation origins fail closed unless they supply an explicit profile id.
- Creation admission belongs to `src/router/handlers/session-creation-preflight.ts`. Registration/ledger and stored-session preflight remain separate owners.
- Wrapper production code may import Worker code only through `src/shared`; Worker production code must not import `wrapper`.
- Public `start` must authorize any supplied `kilocodeOrganizationId` against `organization_memberships` before resolving profile layers or creating session ownership state. Balance validation is billing-only and `x-skip-balance-check` must never bypass organization authorization.
- A control-plane session must remain recoverable after the physical sandbox dies: a new message in the same `workspace_*` session prepares a new sandbox (`docs/control-plane.md`).
- The DOs should remain durable coordinators: queue messages, persist metadata/events, fence wrapper connections, schedule alarms, and prepare/restore sandbox state.
- Put Kilo/job behavior in `wrapper/` or Kilo SDK integration code when it does not require durable DO coordination.
- Avoid growing the control-plane DOs with product behavior that can live in the wrapper, Kilo SDK layer, or a small helper module.

### Runtime Guidelines

- Durable Object calls should be retried using `withDORetry` (this service's logger-bound wrapper is `src/utils/do-retry.ts`). See the `durable-objects` skill (`references/repo-conventions.md`) for the shared `withDORetry` pattern used across services.
- Execute commands inside a session context (use `session.exec(...)`, not `sandbox.exec(...)`)

### Testing Standards

- Unit tests: `src/**/*.test.ts` (Vitest Node)
- Integration tests: `test/**/*.test.ts` (Workers runtime)
- Use `vitest.workers.config.ts` for Workers runtime tests

### Git Workflow

- Create feature branches; do not commit on main

## Key Locations

- `src/router/handlers/` - API endpoints (start, send, split prepare/initiate adapters, session management)
- `src/control-plane/session/` - Session DO schema, messages, routes, callbacks and terminals
- `src/control-plane/sandbox/` - Sandbox DO allocation, credentials, runtime and worktree state
- `src/websocket/` - Client stream and filters
- `src/utils/` - Shared helpers (encryption, retries, SQL helpers)
- `wrangler.jsonc` - Bindings: R2, Hyperdrive, queues, containers, service bindings (`GIT_TOKEN_SERVICE`)
- `vitest.config.ts` - Unit test config
- `vitest.workers.config.ts` - Integration test config
- `wrapper/` - Control wrapper and supervisor shipped into the sandbox
