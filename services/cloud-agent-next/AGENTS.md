# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Project Overview

Cloudflare Worker that powers Kilocode Cloud Agents. It exposes tRPC APIs for starting sessions and sending messages, streams output over WebSockets, and orchestrates Cloudflare Sandbox containers that run the Kilo wrapper.

The Durable Object is intentionally a small coordinator: it durably queues messages when a sandbox or wrapper is not ready, owns session metadata and event replay state, schedules alarms, prepares or restores the sandbox, and hands prompts to the wrapper. Most product behavior after the sandbox is available belongs on the wrapper/Kilo side. Keep the DO focused on durable coordination, not feature logic.

Git tokens (GitHub App installation tokens, managed GitLab tokens) are resolved via the shared `git-token-service` Worker. The wrapper in `wrapper/` brokers Kilo SDK events into the worker’s `/ingest` WebSocket and owns the job lifecycle inside the sandbox.

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

### Local fake-LLM smoke harness

- `services/cloud-agent-next/test/e2e/README.md` is the source of truth for setup, fake-LLM routing, lifecycle directives, and troubleshooting.
- Prefer focused scenario debugging first: `pnpm exec tsx services/cloud-agent-next/test/e2e/run.ts <lifecycle> <conversation>`.
- Run the aggregate local regression matrix with `pnpm exec tsx services/cloud-agent-next/test/e2e/smoke.ts` when validating the full real Worker + DO + sandbox + wrapper path.
- This harness is local/manual rather than part of normal `pnpm test` or CI; use `dev/logs/cloud-agent-next.log` and `dev/logs/fake-llm.log` when debugging it.
- Read `services/cloud-agent-next/DEBUG.md` when correlating local Wrangler logs with Docker sandbox containers, wrapper log files, Kilo CLI logs, uploaded archives, or stuck session flows.

### Code Quality

- `pnpm run lint` - oxlint
- `pnpm run format` - oxfmt write (src only)
- `pnpm run format:check` - oxfmt check (src only)
- `pnpm run typecheck` - TypeScript (tsgo) + wrapper typecheck

### Deployment

- DO NOT attempt to deploy directly. Always defer to the user.

## Architecture Overview

### Core Worker

- `src/index.ts` - Entry point, request routing
- `src/router/` - tRPC router and handlers
- `src/router/handlers/session-start.ts` - Primary `start` endpoint
- `src/router/handlers/session-send.ts` - Primary follow-up `send` endpoint
- `src/router/handlers/session-prepare.ts` - Legacy `prepareSession` adapter
- `src/router/handlers/session-execution.ts` - Legacy V2 queue adapters
- `src/session/session-requests.ts` - Grouped internal session request types
- `src/session/session-registration.ts` - Grouped start creation/admission and legacy registration-only creation
- `src/session/queue-message.ts` - Shared grouped queue command helper
- `src/session-service.ts` - Sandbox/workspace lifecycle orchestration
- `src/workspace.ts` - Workspace setup and git operations
- `src/websocket/stream.ts` - Client-facing WebSocket stream
- `src/websocket/ingest.ts` - Wrapper-facing ingest WebSocket

### Durable Objects

- `src/persistence/CloudAgentSession.ts` - Session DO storage + lifecycle
- `src/persistence/session-metadata.ts` - Current grouped metadata schema plus legacy read fallback
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
- Prefer grouped domain structures for new internals. Do not introduce new flat shared request or metadata shapes.

### Cloud Agent Architecture

- Treat `messageId` as the durable user-message identity. Queued/accepted admission may replay idempotently, but completed/failed/interrupted IDs are final and must not be re-admitted. Legacy `executionId` exists only as a compatibility alias in V2 response paths.
- Public legacy endpoints may accept flat input, but handlers should adapt that input at the boundary into grouped `SessionCreateRequest` or `QueueMessageInput`.
- New session metadata writes must use grouped `SessionMetadata` with `metadataSchemaVersion: 2`.
- Legacy flat metadata reads are allowed only inside `src/persistence/session-metadata.ts` via `parseSessionMetadata`. Application code should consume current grouped metadata only.
- Grouped `start` sends its already accepted canonical initial turn through `createSessionWithInitialAdmission`; retries must preserve the stored immutable intent and complete queue event/drain side effects without duplicate queue events. Current admission accepts submitted or already-canonical turns only; the retained legacy prepared-session adapter reconstructs stored initial turns before admission.
- New pending-message writes use a versioned record containing one nested immutable `SessionMessageIntent`, delivery retry state, and callback snapshot; flat pending rows are decoded only inside `src/session/pending-messages.ts`.
- `SessionMessageState` owns lifecycle/outbox status, terminal effect accounting, and a named immutable `admissionSnapshot` only for post-pending replay validation and recovery; predecessor records normalize into partial `legacyAdmissionConstraints` and never fabricate missing immutable input. Terminal and accepted/sent effects are repairable from pending/alarm replay and events use deterministic uniqueness.
- Wrapper handoff is currently at-least-once under ambiguous delivery failures: the wrapper forwards prompt/command submissions directly to Kilo and does not query Kilo to suppress or recover duplicate `messageId` submissions. Duplicate prompt/command processing is an accepted edge-case trade-off until Kilo provides an atomic submit-or-return-existing contract.
- Once accepted work has no pending residue and its fenced wrapper runtime/socket is gone, current DO/Worker interfaces have no bounded authoritative Kilo terminal query. Disconnect or liveness expiry therefore terminalizes remaining accepted work as wrapper failure without redispatch; adding an authoritative Kilo recovery contract is separate lifecycle capability work.
- Callback delivery retry policy is paired with `wrangler.jsonc`: `CALLBACK_DELIVERY_MAX_ATTEMPTS` includes the initial attempt, and each Cloud Agent Next callback queue consumer must configure `max_retries` for the remaining redeliveries.
- Queue/drain emits unfenced `MessageDeliveryRequest`; only `AgentRuntime` may allocate/reuse current identity and construct `FencedWrapperDispatchRequest` with complete `WrapperRunFence` for downstream dispatch.
- Session creation selects an explicit `ProfileResolutionPolicy` at the handler boundary; only the `include-web-defaults` policy resolves web default/repository-bound profile layers without an explicit profile id.
- Public `start` must authorize any supplied `kilocodeOrganizationId` against `organization_memberships` before resolving profile layers or creating session ownership state. Balance validation is billing-only and `x-skip-balance-check` must never bypass organization authorization.
- Current wrapper identity is fenced `wrapperRunId` plus generation/connection; do not reintroduce execution-ID-only reconnect, supervision, or pending-drain blocking. Legacy endpoint/result/callback `executionId` fields remain boundary compatibility aliases only.
- The DO should remain a durable coordinator: queue messages, persist metadata/events, fence wrapper connections, schedule alarms, prepare/restore sandbox state, and hand work to the wrapper.
- Put Kilo/job behavior in `wrapper/` or Kilo SDK integration code when it does not require durable DO coordination.
- Avoid growing `CloudAgentSession.ts` with product behavior that can live in the wrapper, Kilo SDK layer, or a small helper module.

### Runtime Guidelines

- Durable Object calls should be retried using `withDORetry` in `src/utils/do-retry.ts`
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
- `wrangler.jsonc` - Bindings: R2, Hyperdrive, queues, containers, service bindings (`SESSION_INGEST`, `GIT_TOKEN_SERVICE`)
- `vitest.config.ts` - Unit test config
- `vitest.workers.config.ts` - Integration test config
- `wrapper/` - Wrapper build shipped into the sandbox
