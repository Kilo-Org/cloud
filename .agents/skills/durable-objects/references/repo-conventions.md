# Repo Conventions — Worker/DO Services in This Monorepo

Always bias towards following established patterns in existing services. These
are merely guidelines.

## DO call retries

Retry Durable Object stub calls with `withDORetry` from `@kilocode/worker-utils`
(`packages/worker-utils/src/do-retry.ts`) rather than hand-rolling retry/backoff
loops. It creates a fresh stub per attempt (required, since certain errors break a
stub), retries only errors with Cloudflare's documented `.retryable === true`
property, and applies jittered exponential backoff.

```ts
const result = await withDORetry(
  () => env.MY_DO.get(env.MY_DO.idFromName(key)), // fresh stub per attempt
  stub => stub.getMetadata(),
  'getMetadata'
);
```

Services that need service-local log correlation wrap it with their own logger
bound in, e.g. `services/cloud-agent-next/src/utils/do-retry.ts` and
`services/webhook-agent-ingest/src/util/do-retry.ts` — both are thin
logger-binding adapters over the shared `withDORetry`, not reimplementations.
Prefer this pattern (a local `withDORetry` re-export bound to the service logger)
over calling the base helper directly with no logger, and over copying the retry
loop itself.

## DO stub helper

Each DO module must export a `get{ClassName}Stub` helper function (e.g.
`getRigDOStub`) that centralizes how that DO namespace creates instances. Callers
use this helper instead of accessing the namespace binding directly.

## Sub-modules for large DOs

When a Durable Object grows beyond a few hundred lines, extract domain logic into
sub-modules under a `<do-name>/` directory alongside the DO file. For example,
`Town.do.ts` delegates to modules in `town/`:

```
dos/
  Town.do.ts            # Class definition, RPC methods, alarm loop
  town/
    agents.ts           # Agent CRUD, hook management
    beads.ts            # Bead CRUD, convoy progress
```

Each sub-module exports plain functions (not classes) that accept `SqlStorage` and
any other required context as arguments. The DO imports them with the
`import * as X` pattern:

```ts
import * as beadOps from './town/beads';
import * as agents from './town/agents';
import * as scheduling from './town/scheduling';

// In the DO class:
beadOps.updateBeadStatus(this.sql, beadId, 'closed', agentId);
agents.getOrCreateAgent(this.sql, 'polecat', rigId, this.townId);
await scheduling.schedulePendingWork(this.schedulingCtx);
```

This keeps the DO class thin (RPC surface + orchestration) while sub-modules own
the business logic. The `import * as X` pattern makes call sites self-documenting —
you can always tell which domain a function belongs to.

## IO boundaries

- Validate data at IO boundaries (HTTP responses, JSON.parse results, SSE
  event payloads, subprocess output, upstream responses, persisted session
  records) with Zod schemas. Return `unknown` from raw fetch/parse helpers and
  `.parse()` in the caller.
- Never use `as` to cast IO data. If the shape is known, define a Zod schema; if
  not, use `.passthrough()` or a catch-all schema.

## DB clients

See `workers-best-practices` skill (`references/rules.md` → "Repo rule: never
cache DB clients/pools in module scope") for the Hyperdrive/`getWorkerDb`
lifecycle rule shared by all Workers in this repo. Durable Object instance fields
(e.g. a Drizzle/SQLite wrapper over `state.storage`) are exempt — that's
object-local state, not module-scope caching.
