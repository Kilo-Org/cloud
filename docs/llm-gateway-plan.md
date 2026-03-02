# llm-gateway Worker — Implementation Plan

## Overview

Move the LLM proxy route (`src/app/api/openrouter/[...path]/route.ts`) from a Next.js
Vercel serverless function to a Cloudflare Worker called `llm-gateway`. The worker
exposes the same paths (`/api/gateway/chat/completions`, `/api/openrouter/chat/completions`),
the same auth, and the same request/response contracts — clients never notice the change.

### Why

- **Performance**: eliminate cold starts, run on Cloudflare's edge with smart placement
  near the database. Workers have 6-hour wall time vs Vercel's 800s limit.
- **Cost**: Workers pricing is more favorable for high-volume streaming requests.
- **Ownership**: the hottest path in the product lives in its own deployable unit with its
  own CI, scaling, and observability.

---

## Architecture

```
Client (extension)
  │
  ▼
llm-gateway (CF Worker)          ← NEW
  ├─ Hyperdrive ──► PostgreSQL
  ├─ KV (BYOK cache)
  ├─ fetch() ──► upstream LLM provider (OpenRouter / Vercel AI Gateway / Mistral / etc.)
  ├─ fetch() ──► abuse-service
  ├─ fetch() ──► o11y service
  └─ ctx.waitUntil() background:
       ├─ usage accounting (PG write + generation fetch + PostHog)
       ├─ API metrics (o11y POST)
       ├─ error capture (Sentry)
       └─ request logging (PG write, Kilo employees only)
```

---

## Key Design Decisions

| Decision              | Choice                                                  | Rationale                                                                                |
| --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shared pure functions | New `@kilocode/llm-shared` package                      | Clean separation; both Next.js route and worker import from one source of truth          |
| Worker route paths    | Same as Next.js (`/api/gateway/…`, `/api/openrouter/…`) | Seamless cutover; clients don't change                                                   |
| BYOK provider cache   | KV binding                                              | Durable across Worker restarts, globally distributed                                     |
| Sentry                | Day 1, via `@sentry/cloudflare`                         | Critical hot path needs observability from the start                                     |
| Custom LLM (AI SDK)   | Included in initial implementation                      | Full feature parity from day 1                                                           |
| Response builders     | Worker uses plain `Response`                            | Re-implement response helpers in the worker; Next.js route keeps `NextResponse` versions |
| `after()` equivalent  | `ctx.waitUntil()`                                       | Direct equivalent; already used in other workers                                         |

---

## Phase 1: Create `@kilocode/llm-shared` Package

**New directory**: `packages/llm-shared/`

Extract pure, runtime-agnostic functions so both the Next.js route and the worker import
from one source of truth. These functions have no `db` imports and no Next.js API usage.

### What moves here

| Source File                               | Exports                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/models.ts`                       | `isFreeModel`, `isKiloFreeModel`, `isDeadFreeModel`, `isDataCollectionRequiredOnKiloCodeOnly`                              |
| `src/lib/rate-limited-models.ts`          | `isRateLimitedToDeath`                                                                                                     |
| `src/lib/kilo-auto-model.ts`              | `isKiloAutoModel`, `resolveAutoModel`                                                                                      |
| `src/lib/model-utils.ts`                  | `normalizeModelId`                                                                                                         |
| `src/lib/providerHash.ts`                 | `generateProviderSpecificHash`                                                                                             |
| `src/lib/feature-detection.ts`            | `validateFeatureHeader`, `FEATURE_HEADER`                                                                                  |
| `src/lib/tool-calling.ts`                 | `repairTools`, `ENABLE_TOOL_REPAIR`, `normalizeToolCallIds`, `dropToolStrictProperties`                                    |
| `src/lib/processUsage.ts`                 | `extractPromptInfo`, `MicrodollarUsageContext` type                                                                        |
| `src/lib/providers/openrouter/types.ts`   | `OpenRouterChatCompletionRequest`, `isFreePromptTrainingAllowed`                                                           |
| `src/lib/anonymous.ts`                    | `AnonymousUserContext`, `createAnonymousContext`, `isAnonymousContext`, `getAnonymousUserId`                               |
| `src/lib/llm-proxy-helpers.ts`            | `estimateChatTokens`, `extractFraudAndProjectHeaders`, `extractHeaderAndLimitLength`, `checkOrganizationModelRestrictions` |
| `src/lib/o11y/api-metrics.server.ts`      | `getToolsAvailable`, `getToolsUsed`                                                                                        |
| `src/lib/providers/index.ts`              | `PROVIDERS` object, `applyProviderSpecificLogic`, `shouldRouteToVercel`                                                    |
| `src/lib/code-reviews/core/constants.ts`  | `isActiveReviewPromo`                                                                                                      |
| `src/lib/promotions/cloud-agent-promo.ts` | `isActiveCloudAgentPromo`                                                                                                  |
| `src/lib/constants.ts`                    | `PROMOTION_MAX_REQUESTS`, `PROMOTION_WINDOW_HOURS`                                                                         |

### What does NOT move

Response builders that return `NextResponse` stay in `src/lib/`. The worker will have its
own plain `Response` equivalents in `src/responses.ts`.

### Migration step

Update the Next.js route to import from `@kilocode/llm-shared` instead of `src/lib/` for
every extracted function. Run the full test suite to verify nothing breaks.

---

## Phase 2: Worker Scaffold

**New directory**: `llm-gateway/`

```
llm-gateway/
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Hono app, Sentry.withSentry() wrapper
│   ├── types.ts                    # Env bindings type
│   ├── logger.ts                   # workers-tagged-logger setup
│   ├── responses.ts                # Plain Response error builders
│   ├── routes/
│   │   └── chat-completions.ts     # POST handler
│   ├── services/
│   │   ├── auth.ts                 # JWT validation (Authorization header only)
│   │   ├── provider.ts             # Provider selection (BYOK, custom LLM, etc.)
│   │   ├── balance.ts              # Balance / org settings queries
│   │   ├── rate-limit.ts           # Free model IP rate limiting + promotion limits
│   │   ├── upstream.ts             # fetch to upstream LLM provider
│   │   ├── custom-llm.ts           # AI SDK direct provider calls
│   │   └── abuse.ts                # classifyAbuse HTTP call
│   ├── background/                 # All ctx.waitUntil() work
│   │   ├── usage-accounting.ts     # countAndStoreUsage → PG + generation fetch
│   │   ├── metrics.ts              # POST to o11y service
│   │   ├── error-capture.ts        # Sentry captureMessage for proxy errors
│   │   └── request-log.ts          # api_request_log insert (Kilo employees only)
│   └── lib/
│       └── db.ts                   # getWorkerDb wrapper
```

### wrangler.jsonc

```jsonc
{
  "name": "llm-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-01",
  "compatibility_flags": ["nodejs_compat"],
  "placement": { "mode": "smart" },
  "observability": { "enabled": true },
  "upload_source_maps": true,
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "624ec80650dd414199349f4e217ddb10",
      "localConnectionString": "postgres://postgres:postgres@localhost:5432/postgres",
    },
  ],
  "kv_namespaces": [
    {
      "binding": "BYOK_CACHE",
      "id": "<to-be-created>",
    },
  ],
  "secrets_store_secrets": [
    {
      "binding": "NEXTAUTH_SECRET",
      "secret_name": "NEXTAUTH_SECRET",
      "store_id": "342a86d9e3a94da698e82d0c6e2a36f0",
    },
    {
      "binding": "OPENROUTER_API_KEY",
      "secret_name": "OPENROUTER_API_KEY",
      "store_id": "342a86d9e3a94da698e82d0c6e2a36f0",
    },
    {
      "binding": "SENTRY_DSN",
      "secret_name": "LLM_GATEWAY_SENTRY_DSN",
      "store_id": "342a86d9e3a94da698e82d0c6e2a36f0",
    },
  ],
  "vars": {
    "ENVIRONMENT": "production",
  },
}
```

### package.json dependencies

```json
{
  "dependencies": {
    "hono": "catalog:",
    "zod": "catalog:",
    "drizzle-orm": "catalog:",
    "pg": "catalog:",
    "@kilocode/worker-utils": "workspace:*",
    "@kilocode/db": "workspace:*",
    "@kilocode/llm-shared": "workspace:*",
    "@sentry/cloudflare": "^10.25.0",
    "workers-tagged-logger": "catalog:",
    "jsonwebtoken": "catalog:",
    "ai": "catalog:",
    "@ai-sdk/anthropic": "catalog:",
    "@ai-sdk/openai": "catalog:"
  },
  "devDependencies": {
    "wrangler": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "@cloudflare/vitest-pool-workers": "catalog:",
    "@cloudflare/workers-types": "catalog:"
  }
}
```

---

## Phase 3: Core Handler Implementation

The handler in `routes/chat-completions.ts` follows the exact same sequence as the
existing route. Each numbered step maps 1:1 to the Next.js implementation.

### Request flow

1. **Parse & validate** request body — same JSON parse, `stream_options.include_usage`
   injection, `models` field deletion, model string validation.

2. **Auto-model resolution** — `isKiloAutoModel` → `resolveAutoModel` with
   `x-kilocode-mode` header.

3. **IP extraction** — use `CF-Connecting-IP` (more reliable than `X-Forwarded-For` in
   CF Workers). Fall back to `X-Forwarded-For` for compatibility.

4. **Free model rate limit** — PG query against `free_model_usage` table via Hyperdrive.
   Return 429 if exceeded.

5. **Auth** — JWT validation only (no NextAuth cookie/session path). Verify HS256 JWT
   signed with `NEXTAUTH_SECRET`, look up user in `kilocode_users` via Hyperdrive.
   Validate `api_token_pepper`, check blacklist/blocked status, check org membership.

6. **Anonymous fallback** — if auth fails and model is free,
   `createAnonymousContext(ipAddress)`. Check promotion limit for anonymous users.

7. **Free model request logging** — PG insert into `free_model_usage`.

8. **Provider selection** — port `getProvider` logic. BYOK lookups use Hyperdrive + KV
   cache (TTL-based). Custom LLM lookup via Hyperdrive.

9. **Abuse classification** — non-blocking HTTP call to abuse service, raced with 2s
   timeout. Fail-open.

10. **Max tokens check** — reject if `max_tokens > 99999999999`.

11. **Dead/rate-limited model check** — return early if model is dead or rate-limited.

12. **Balance/org checks** — PG query via Hyperdrive. Check org model/provider
    restrictions.

13. **Provider-specific mutations** — `applyProviderSpecificLogic` (from
    `@kilocode/llm-shared`).

14. **Tool repair** — `repairTools` (from `@kilocode/llm-shared`).

15. **Prompt cache key + safety identifier** — `generateProviderSpecificHash`.

16. **Upstream request** — standard `fetch()` to the provider URL.

17. **Response processing**:
    - `ctx.waitUntil()`: usage accounting, API metrics, error capture, request logging
    - Blocking: error readability transform, free model response rewriting
    - Return response to client

### Key differences from Next.js version

| Next.js                             | Worker                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `after(promise)`                    | `c.executionCtx.waitUntil(promise)`                          |
| `NextResponse`                      | `Response`                                                   |
| `headers()` from `next/headers`     | `c.req.header()` (Hono)                                      |
| `db` singleton from `@/lib/drizzle` | `getWorkerDb(c.env.HYPERDRIVE.connectionString)` per-request |
| `@sentry/nextjs`                    | `@sentry/cloudflare`                                         |
| `unstable_cache`                    | KV binding                                                   |
| `getUserFromAuth` (cookie + JWT)    | JWT-only auth                                                |
| `X-Forwarded-For` for IP            | `CF-Connecting-IP` (fallback: `X-Forwarded-For`)             |
| `getServerSession(authOptions)`     | Not needed — API clients use Bearer tokens                   |

---

## Phase 4: Custom LLM Support

Port `src/lib/custom-llm/customLlmRequest.ts` into `services/custom-llm.ts`.

Changes required:

- `NextResponse.json(...)` → `Response.json(...)` (3 occurrences)
- `new NextResponse(stream, ...)` → `new Response(stream, ...)`
- The `temp_phase` DB lookup routes through Hyperdrive instead of the `db` singleton
- The AI SDK (`streamText`, `generateText`, `createAnthropic`, `createOpenAI`) uses
  standard `fetch` internally and is edge-compatible

---

## Phase 5: Observability

### Sentry

Follow the `cloudflare-deploy-infra/builder/` pattern:

```ts
// src/index.ts
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    environment: env.ENVIRONMENT || 'production',
  }),
  app
);
```

Post-deploy script uploads sourcemaps via `@sentry/cli`.

### Structured logging

```ts
// src/logger.ts
import { WorkersLogger } from 'workers-tagged-logger';

export type LlmGatewayTags = {
  userId?: string;
  organizationId?: string;
  model?: string;
  provider?: string;
  requestId?: string;
};

export const logger = new WorkersLogger<LlmGatewayTags>({ minimumLogLevel: 'debug' });
export { withLogTags } from 'workers-tagged-logger';
```

### API metrics

Same POST to o11y service (`/ingest/api-metrics`) via `ctx.waitUntil()`. Identical
payload shape.

---

## Phase 6: Testing

### Unit tests (Vitest)

- Auth JWT validation with valid/invalid/expired tokens
- Provider selection logic for each provider type (OpenRouter, Vercel, BYOK, custom)
- Rate limit threshold checks
- Request body mutations (stream_options injection, tool repair, etc.)
- Response rewriting (free model response, error readability)

### Integration tests (`@cloudflare/vitest-pool-workers`)

- Full handler tests with mocked upstream providers
- Hyperdrive PG integration with test database
- KV cache read/write for BYOK
- `ctx.waitUntil()` background task execution

### Comparison tests

- Send identical requests to both Next.js route and Worker
- Diff response status, headers, and body (byte-level for streaming)
- Verify usage records appear identically in the database
- Verify metrics reach the o11y service

---

## Phase 7: Deployment & Traffic Cutover

### Step 1 — Deploy to staging

Deploy the worker. Verify it works end-to-end against the staging database.

### Step 2 — Shadow mode

Update the Next.js route to also forward a clone of the request to the worker (fire-and-
forget via `after()`). Log and compare responses for correctness validation. Do not
serve the worker's response to the client yet.

### Step 3 — Gradual rollout

Route increasing traffic percentages to the worker. Options:

- Cloudflare Workers route on the domain with percentage-based splitting
- Client-side feature flag (extension sends requests to the worker URL)
- Header-based routing in a Cloudflare rule

### Step 4 — Full cutover

All traffic goes to the worker. Next.js routes become thin proxies that forward to the
worker (for clients that haven't updated their URL).

### Step 5 — Deprecation

Remove the Next.js routes once all clients have migrated to the worker URL.

---

## Risk Mitigations

| Risk                                  | Mitigation                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG connection issues via Hyperdrive   | Smart placement keeps worker near DB; Hyperdrive handles pooling. Monitor connection errors.                                                                                      |
| Missing side-effects (usage, metrics) | Shadow mode comparison catches discrepancies before cutover.                                                                                                                      |
| AI SDK incompatibility in Workers     | SDK uses standard `fetch`, documented as edge-compatible. Test early with integration tests.                                                                                      |
| JWT validation differences            | Same `jsonwebtoken` library, same secret. Unit test with production-format tokens.                                                                                                |
| Streaming response byte differences   | `rewriteFreeModelResponse` must produce identical SSE output. Integration test with byte-level streaming assertions.                                                              |
| KV cache staleness for BYOK           | Set reasonable TTL (5 min). KV eventual consistency is acceptable — worst case a user sees their old provider for a few minutes after changing BYOK keys.                         |
| Worker CPU time limits (30s)          | The hot path is I/O-bound (PG queries, upstream fetch), not CPU-bound. Streaming responses don't count against CPU time. `ctx.waitUntil()` background work has its own allowance. |
