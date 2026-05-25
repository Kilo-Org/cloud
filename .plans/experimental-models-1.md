# Experimental Models — Part 1: Core A/B Experiment System

## Implementation Status (read this first)

<!--
  Update this block when phase status changes. Format:
    [done]       implemented
    [done-core]  core implementation exists; explicit follow-ups remain
    [partial]    some implementation/tests exist; durable work remains
    [todo]       not started
-->

| Phase | Status | Current State |
|---|---|---|
| Phase 1 — Schema + Migration | [done] | Experiment tables exist. `model_experiment_request` is monthly range-partitioned on `created_at`, uses primary key `(usage_id, created_at)`, and stores one full-body prompt hash plus `request_kind`. |
| Phase 2 — Gateway Header Capture | [done] | Gateway captures `x-kilo-request`, `x-kilo-session`, and `x-kilocode-machineid`, and passes the client request id, session id, machine id, and client IP into routing/usage context. |
| Phase 3 — Variant Picker + Routing | [done] | Experimented public ids route through the deterministic picker, load routing details from Postgres after Redis membership pre-check, and go directly to the selected partner upstream. |
| Phase 4 — Usage, Metrics, Reporting | [done-core] | Attribution rows and R2 prompt bodies are written after microdollar usage. Admin request log reads the rows inline. Live aggregate reporting and `model_experiment_request_stats` are deferred until a report consumer needs them. |
| Phase 5 — Admin tRPC + UI | [done-core] | Admin CRUD, state transitions, variant version hot-swap, key rotation, UI tab, request log, and prompt-body download exist. `getLiveStats` and inline prompt inflation via tRPC are still deferred. |
| Phase 6 — Specs + Tests | [done-core] | Durable rules now live in `.specs/model-experiments.md` and are registered in `AGENTS.md`. Router, picker, prompt persistence, partitioning, and soft-delete policy tests exist; response client-blinding tests remain with the response-rewrite follow-up below. |

**Current schema:**

- `model_experiment` table with partial unique index on `public_model_id` where status in (`active`, `paused`), status CHECK, and "active not archived" CHECK.
- `model_experiment_variant` table with `(experiment_id, label)` unique constraint and `weight > 0` CHECK.
- `model_experiment_variant_version` table with `(variant_id, effective_at desc)` index. `upstream` is plain `jsonb` (validation by `ExperimentUpstreamSchema` in app code). `encrypted_api_key` is `jsonb` typed `EncryptedData` (matches `byok_api_keys.encrypted_api_key`).
- `model_experiment_request` table is monthly range-partitioned on `created_at`, with primary key `(usage_id, created_at)`, `usage_id` FK to `microdollar_usage(id) on delete cascade`, `(variant_version_id, created_at)` index, partial index on `client_request_id` where not null, allocation-subject CHECK, request-kind CHECK, and `request_body_sha256` hash/sentinel CHECK.
- Drizzle types exported: `ModelExperiment` / `New…`, `ModelExperimentVariant` / `New…`, `ModelExperimentVariantVersion` / `New…`, `ModelExperimentRequest` / `New…`.
- `ExperimentUpstreamSchema` lives in `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts` and validates the `upstream` JSONB app-side.
- `request_body_sha256` is the single content-addressed prompt-body reference; there is no separate system-prompt hash column.

**Remaining schema/reporting work:**

- The `model_experiment_request_stats` reporting view is deferred. See Phase 4d note below.
- Automatic retention-window enforcement and prompt-orphan R2 GC are deferred follow-ups.

**Phase 2 — current output:**

- `apps/web/src/app/api/openrouter/[...path]/route.ts` — extracts `x-kilo-request` into `clientRequestId` and `x-kilo-session` as fallback for `session_id` when `x-kilocode-taskid` is absent. Captures `x-kilocode-machineid` once into `machineIdHeader` and threads it (plus the resolved client IP) into `getProvider`.
- `apps/web/src/lib/ai-gateway/processUsage.types.ts` — extends `MicrodollarUsageContext` with optional `clientRequestId`, `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, and `experimentPromptCapture`. Optional so the dozens of construction sites in routes/tests/helpers don't need touching. Adds `ExperimentPromptCapture` type.

**Phase 3 — current output:**

- `apps/web/src/lib/ai-gateway/experiments/build-direct-provider.ts` — `buildDirectProvider(input)` + `inferSupportedChatApis(...)`. Used by both the new experiment branch and the existing `kilo-internal/...` (custom_llm2) path so direct-to-upstream traffic shares one implementation. Custom_llm passes `extra_headers`; experiments deliberately don't (excluded from `ExperimentUpstreamSchema`).
- `apps/web/src/lib/ai-gateway/experiments/membership.ts` — Redis-backed membership pre-check with a short in-process cache. It is split away from Drizzle-using routing code so free-model checks can import it without pulling server-only database modules into client-reachable bundles.
- `apps/web/src/lib/ai-gateway/experiments/pick-variant.ts` — `getRoutingExperimentForPublicId(publicId)` loads routing-relevant experiment data from Postgres, uses `SELECT DISTINCT ON (variant_id)` to pick each variant's current version, and returns `none` / `experiment` / `unavailable`. `pickModelExperimentVariant(input)` deterministically walks cumulative weights in id-asc order, with allocation subject precedence user → machine → ip; missing all subjects returns `unavailable`. Partner API keys stay encrypted at rest and are decrypted for the selected variant rather than being cached in Redis as plaintext.
- `apps/web/src/lib/ai-gateway/providers/get-provider.ts` — refactored to return discriminated `GetProviderResult` (`provider` / `not-found` / `unavailable`). Adds the experiment branch after BYOK and before `kilo-internal/...` and the `kiloExclusiveModels` lookup. Active selections attach `experiment` metadata and set only the direct-routing flags still needed after the `isFreeModel` refactor. Custom_llm path refactored to use `buildDirectProvider`.
- `apps/web/src/app/api/openrouter/[...path]/route.ts` — calls the new `getProvider({...})` signature with `clientIp` + `machineId`, handles `not-found` (local model-unavailable) and `unavailable` (503 temporarily-unavailable) before reading `provider.supportedChatApis`. Experiment ids are treated as free/provider-funded via `isFreeModel`; organization model restrictions still run, while direct-routing-incompatible data-collection/provider-allow-list policies fail closed. Sets `usageContext.modelExperimentVariantVersionId` + `modelExperimentAllocationSubject` from the result and calls `buildExperimentPromptCapture` after provider transforms for experimented requests only.
- `apps/web/src/lib/ai-gateway/providers/apply-provider-specific-logic.ts` — accepts an optional options bag with `skipKiloExclusiveModelSettings` so the registry's `internal_id`/provider rewrite doesn't override the variant's upstream. Generic provider-specific request fixes and `provider.transformRequest` still run.
- `apps/web/src/lib/ai-gateway/auto-model/resolution.ts` — no auto-router changes. `autoFreeModels` and the frontier preset list are hand-curated and don't overlap with experiment preview ids; the explicit-opt-in property is preserved by construction. Avoids paying per-candidate Redis membership checks on every `kilo-auto/free` request.

**Phase 4a–c — current output:**

- `apps/web/src/lib/r2/experiment-prompts.ts` — `putPromptIfAbsent(content)` / `putPromptOrNull(content)` under sha256 hex keys for automatic dedup, `getPromptByHash(sha)` for out-of-band reads with strict 64-char hex validation, and `sha256Hex(content)`. Prompt put failures translate to the `__failed__` sentinel.
- `apps/web/src/lib/r2/client.ts` — adds `R2_EXPERIMENT_PROMPTS_BUCKET_NAME` env var and `r2ExperimentPromptsBucketName` export. Per-environment buckets `kilo-experiment-prompts-dev` / `kilo-experiment-prompts-prod`.
- `apps/web/src/lib/ai-gateway/experiments/persist.ts` — `buildExperimentPromptCapture(request)` serializes the full canonical post-`transformRequest` body as one content-addressed blob, records `requestKind`, and caps the serialized UTF-8 payload at 4 MB with deterministic valid-UTF-8 truncation. `persistExperimentAttribution(input)` does one best-effort R2 put and inserts one row into `model_experiment_request` with `request_body_sha256` set to either the real hash or `__failed__`; errors are reported and swallowed so attribution never rolls back billing.
- `apps/web/src/lib/ai-gateway/processUsage.ts` — `logMicrodollarUsage` and `processTokenData` return `{ usageId, createdAt }` so the experiment attribution row keys onto the same usage row. Existing callers ignoring the return value are unaffected.
- `apps/web/src/lib/ai-gateway/llm-proxy-helpers.ts` — `accountForMicrodollarUsage` chains `persistExperimentAttribution` after the microdollar write inside the same `after()` hook, only for experimented requests.

**Phase 4d — deferred:**

Add `model_experiment_request_stats` when `getLiveStats` or another aggregate report needs a stable column set. The view should centralize the request → variant version → variant → experiment join and expose only non-key columns such as `upstream->>'internal_id'`, `upstream->>'base_url'`, `variant_label`, and `experiment_id`. It must not select `encrypted_api_key` or any plaintext key.

**Membership cache:**

The gateway keeps `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` as the admin-maintained membership set and wraps Redis reads in a short in-process cache (`apps/web/src/lib/ai-gateway/experiments/membership.ts`). If Redis is empty, corrupt, or unavailable, `isPublicIdExperimented(publicId)` treats that as no experimented public ids rather than doing per-miss Postgres fallback queries on the hot path. This preserves the cache's purpose: most requests are non-experiment requests, so a DB lookup on every negative membership result is not acceptable.

Operational consequence: admin mutations that move experiments into or out of routing states must recompute the membership key successfully. The gateway then reads experiment routing details from Postgres only after membership says a public id is experimented.

**Phase 5 — current output:**

- `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts` — `ExperimentUpstreamSchema` (strict subset of `CustomLlmDefinitionSchema`, no `api_key`, no `extra_headers`).
- `apps/web/src/lib/redis-keys.ts` — `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` helper used by Phase 3 membership checks and admin recomputation on routing-affecting status changes.
- `apps/web/src/lib/redis.ts` — includes `redisDel(key)` helper.
- `apps/web/src/routers/admin/model-experiments-router.ts` — full CRUD + state machine (`activate`, `pause`, `complete`, `setArchived`, `delete`-on-draft) + variant ops (`addVariant`, `removeVariant`, `updateVariantLabel`, `swapVariantVersion`, `rotateApiKey`). All routing-affecting mutations invalidate per-public-id cache and recompute the membership set. `encrypted_api_key` is **never** selected by `list`/`get`/`swapVariantVersion`/`rotateApiKey` — admin response shapers explicitly enumerate non-key columns. `BYOK_ENCRYPTION_KEY` missing → `INTERNAL_SERVER_ERROR` on key-touching ops.
- Wired into `apps/web/src/routers/admin-router.ts` as `trpc.admin.modelExperiments.*`.
- `apps/web/src/app/admin/api/model-experiments/hooks.ts` — react-query hooks for every procedure.
- `apps/web/src/app/admin/model-experiments/ModelExperimentsContent.tsx` — list + detail (inline) + create dialog + add-variant dialog + Monaco-based hot-swap dialog (validates `ExperimentUpstreamSchema` strict before submit) + rotate-key dialog. Status badges, share = `weight / sum(weights)`, structural-edit lock for non-draft.
- `apps/web/src/app/admin/gateway/page.tsx` — includes "Model Experiments" as the fourth tab inside `/admin/gateway`.
- `apps/web/src/app/admin/model-experiments/page.tsx` — redirects to `/admin/gateway?tab=model-experiments` (mirrors `custom-llms`).

**Phase 5 — deferred:**

- `getLiveStats(id)` tRPC procedure — still deferred until a real aggregate reporting consumer needs a stable query/result shape.
- Inline prompt inflation via a `getPromptByHash(sha)` tRPC procedure — R2 helpers exist, and admins can already download captured bodies through the request browser.

> **Scope: preview/experimental models only.** This system exists to A/B test
> unreleased model checkpoints in partnership with model providers. It is **not**
> a general traffic-splitting mechanism for production models.
>
> **Opt-in only.** Experimented `public_model_id`s are dedicated preview model
> ids (e.g. `kilo/preview-experiment-foo`) that a user must explicitly select.
> They are excluded from `kilo-auto` candidate sets and never silently chosen
> on a user's behalf. A user only ever hits this code path by opting into the
> preview model. Users on production model ids are never bucketed.

> See also: [Part 2 — Partner Trace Export & Replay Roadmap](./experimental-models-2.md)

### Goal

Run A/B tests against model checkpoints in partnership with model providers, especially during preview / early development. Providers should be able to compare variants on real production traffic while Kilo can deliver clean per-checkpoint results without exposing experiment assignment to clients.

### Durable Rules

The durable business rules and invariants now live in `.specs/model-experiments.md`. This plan records implementation history, current state, and follow-up engineering work. If the plan and spec disagree on product behavior, update the spec first and then adjust this plan to match.

### Existing Building Blocks

- Deterministic hash bucketing: `apps/web/src/lib/ai-gateway/getRandomNumber.ts`.
- Runtime A/B precedent: `apps/web/src/lib/ai-gateway/providers/vercel/index.ts`, cached in Redis for ~10 minutes.
- Direct-to-upstream routing pattern: the `kilo-internal/...` branch in `getProvider` (`apps/web/src/lib/ai-gateway/providers/get-provider.ts`) returns a `{ provider, userByok: null, bypassAccessCheck: true }` result built from a `custom_llm2` row. The `Provider` itself has `{ id: 'custom', apiUrl, apiKey, supportedChatApis, transformRequest }`; `bypassAccessCheck` lives on the `getProvider` return value, not inside the provider. `upstream-request.ts` then `fetch`es `${provider.apiUrl}${path}${search}` with `Authorization: Bearer ${provider.apiKey}` — OpenRouter and Vercel are never contacted. Experiments reuse this direct-provider shape, with the upstream config sourced from the variant version instead of `custom_llm2`.
- Public→internal model rewriting: `applyProviderSpecificLogic` in `apps/web/src/lib/ai-gateway/providers/apply-provider-specific-logic.ts`, called from `apps/web/src/app/api/openrouter/[...path]/route.ts` after provider resolution. It rewrites `body.model` to a Kilo-exclusive `internal_id` and may pin `body.provider.only` pre-flight. Variant selection happens earlier, inside `getProvider`; direct experiment providers return `skipKiloExclusiveModelSettings: true` so route-level logic skips only that Kilo-exclusive rewrite while preserving generic request fixes and `provider.transformRequest`.
- Usage telemetry: `microdollar_usage` and `microdollar_usage_metadata` in `packages/db/src/schema.ts`, populated by `apps/web/src/lib/ai-gateway/processUsage.ts`.
- API metrics pipeline: `apps/web/src/lib/ai-gateway/o11y/api-metrics.server.ts` → `services/o11y/src/api-metrics-routes.ts`.
- Admin tRPC pattern: `apps/web/src/routers/admin/gateway-config-router.ts`.
- Existing client feedback flow in `../kilocode`: clients already send `x-kilo-request: <user-message-id>` on Kilo Gateway requests and later send the same value as `Feedback Submitted.parentMessageID`.

No client changes are needed for attribution. The existing `variant` property on client feedback events is a client-side model preset (for example `"thinking"`), not a server A/B bucket, and should be left unchanged.

### Request Flow

```text
POST /api/openrouter/.../chat/completions
  ├─ extract headers: x-kilo-request, x-kilo-session, x-kilocode-taskid, x-kilocode-machineid, ...
  ├─ kilo-auto resolution (unchanged)
  ├─ getProvider(...)
  │    ├─ if isPublicIdExperimented(publicId):
  │    │    ├─ pickModelExperimentVariant({ publicModelId, userId, machineId, clientIp })
  │    │    │    ├─ load active experiment for publicModelId from Postgres (after Redis membership pre-check)
  │    │    │    ├─ choose allocation subject: user → machine → ip (missing all subjects fails closed)
  │    │    │    ├─ bucket with getRandomNumber(seed, sumOfWeights)
  │    │    │    ├─ select variant by cumulative weight
  │    │    │    └─ return { experimentId, variantId, variantVersionId, upstream, allocationSubject }
  │    │    ├─ if paused: return `{ kind: 'not-found' }` (route.ts emits local 404 before dereferencing provider)
  │    │    ├─ if unavailable: return `{ kind: 'unavailable' }` (route.ts emits 503 before dereferencing provider)
  │    │    └─ return buildDirectProvider(upstream) + experiment metadata
  │    └─ else: existing branches (BYOK, kilo-internal, kiloExclusiveModels → openrouter|vercel)
  ├─ construct MicrodollarUsageContext and stash variantVersionId + allocationSubject + clientRequestId from the getProvider result
  ├─ balance check skipped for preview experiments; org model/data-collection policy still enforced
  ├─ applyTrackingIds + applyProviderSpecificLogic / provider.transformRequest
  ├─ build bounded prompt capture from canonical post-transform body and store it on MicrodollarUsageContext
  ├─ upstream fetch (unchanged)
  └─ after():
       ├─ accountForMicrodollarUsage writes usage + experiment request attribution
       ├─ emitApiMetricsForResponse emits experiment dimensions
       └─ handleRequestLogging unchanged
```

## Implementation Plan

### Phase 1 — Schema + Migration

Update `packages/db/src/schema.ts` and generate a migration with `pnpm drizzle generate`.

New tables:

```text
model_experiment
  id                    uuid pk
  public_model_id       text not null
  name                  text not null
  description           text
  status                text not null -- draft | active | paused | completed
  is_archived           boolean not null default false
  created_by_user_id    text fk → kilocode_users(id)
  created_at, updated_at, started_at, ended_at
  partial unique index (public_model_id) where status in ('active', 'paused')
  check (status <> 'active' or is_archived = false)

model_experiment_variant
  id                              uuid pk
  experiment_id                   uuid fk → model_experiment(id) on delete cascade
  label                           text not null
  weight                          integer not null check (weight > 0)
  created_at
  updated_at
  unique (experiment_id, label)
  -- no back-pointer to versions; "current version" is derived from variant_version.effective_at

model_experiment_variant_version
  id                              uuid pk
  variant_id                      uuid fk → model_experiment_variant(id) on delete cascade
  upstream                        jsonb not null  -- ExperimentUpstreamSchema (see below); does NOT contain api_key
  encrypted_api_key               jsonb not null  -- EncryptedData ({iv, data, authTag}); same shape as byok_api_keys.encrypted_api_key
  effective_at                    timestamp not null default now()
  created_by                      text fk → kilocode_users(id)
  created_at                      timestamp not null default now()
  index (variant_id, effective_at desc)
  -- immutable: never UPDATEd; new RC = new version row with effective_at = now() (or a future time for scheduled rollouts, not used in v1)

model_experiment_request
  usage_id                        uuid fk → microdollar_usage(id) on delete cascade
  primary key                     (usage_id, created_at) -- required because the table partitions by created_at
  variant_version_id              uuid not null fk → model_experiment_variant_version(id)
  allocation_subject              text not null -- user | machine | ip
  client_request_id               text nullable
  request_kind                    text not null  -- chat_completions | messages | responses
  request_body_sha256             text not null  -- 64-char R2 object key, or reserved sentinel (see Prompt Storage)
  was_truncated                   boolean not null default false
  created_at                      timestamp not null
  check request_body_sha256 is one of: 64-char lowercase hex, __failed__, __deleted__
```

The `upstream` JSONB blob is validated by `ExperimentUpstreamSchema` (a strict subset of `CustomLlmDefinitionSchema` — see `packages/db/src/schema-types.ts:779-798`):

```ts
const ExperimentUpstreamSchema = z.object({
  internal_id: z.string(),                              // model id sent upstream
  base_url: z.string().url(),                           // upstream endpoint
  opencode_settings: z.object({ ai_sdk_provider: z.enum([...]) }).optional(),
  openclaw_settings: z.object({ api_adapter: z.enum([...]) }).optional(),
  extra_body: z.record(z.unknown()).optional(),
  remove_from_body: z.array(z.string()).optional(),
  add_cache_breakpoints: z.boolean().optional(),
  inject_reasoning_into_content: z.boolean().optional(),
}).strict()
```

The `api_key` is **not** part of `ExperimentUpstreamSchema` and **not** stored in the JSONB blob. It lives in the sibling `encrypted_api_key` column (same `EncryptedData` JSONB shape as `byok_api_keys.encrypted_api_key`) and is decrypted only for the selected variant when building the direct upstream provider. This makes "never select the key" enforceable at the SQL/column level and avoids storing plaintext partner keys in Redis.

`ExperimentUpstreamSchema` deliberately does not include arbitrary `extra_headers` in v1. Partner checkpoint routing should use the encrypted `api_key`, `base_url`, `internal_id`, adapter settings, `extra_body`, and `remove_from_body`. If a provider later requires a non-secret custom header, add an explicit allowlisted field for that concrete requirement rather than reopening arbitrary header storage.

Fields deliberately **not** included (and why): `organization_ids` (the experimented public id is registered in `kiloExclusiveModels` and gates org access there); `pricing` (per-RC pricing is not used in v1); `display_name` / `context_length` / `max_completion_tokens` (these belong on the public id, identical across variants).

`model_experiment_variant` is the slot identity (label, weight, allocation share). `model_experiment_variant_version` is the immutable RC instance held by that slot at a point in time. Hot-swapping an RC is a pure INSERT into `model_experiment_variant_version`; the variant row is not modified. The "current version of variant V at time T" is computed as `SELECT ... FROM model_experiment_variant_version WHERE variant_id = V AND effective_at <= T ORDER BY effective_at DESC, id DESC LIMIT 1` (id used as deterministic tiebreaker for ties at the same millisecond). The picker loads routing details from Postgres after the Redis membership pre-check says the public id is experimented. Old version rows are never modified or deleted, so per-request attribution stays exact via the `variant_version_id` FK on `model_experiment_request` with no snapshot columns and no date-comparison joins. `experiment_id` is reachable via `variant_version_id → variant_id → experiment_id`; storing it on the request row would be denormalization, omitted unless query plans show it's needed.

The status machine, activation rules, structural-edit restrictions, hot-swap semantics, and routing behavior by status are specified in `.specs/model-experiments.md`. The implementation enforces those rules through DB constraints where practical and admin-router guards for stateful validations.

`model_experiment_request` stores experiment attribution only for requests where an experiment was actually applied, with a direct one-to-one link to the usage row.

Indexes for `model_experiment_request`:

- Primary key / unique reference: `(usage_id, created_at)`. `usage_id` remains the one-to-one FK to `microdollar_usage(id)`.
- `(variant_version_id, created_at)` for per-RC reports (the primary checkpoint-level grouping).
- Partial index on `client_request_id` where not null for feedback joins.

Experiment- and variant-level reports go through join: `request → variant_version → variant → experiment`. The served upstream config is read from `model_experiment_variant_version.upstream` JSONB; reports surface `upstream->>'internal_id'` and (where useful) `upstream->>'base_url'`. **Never select `upstream->>'api_key'` in any reporting view, admin query, or response payload.** If query plans show the join hop is hot, add a covering index or denormalize `variant_id` and/or `experiment_id` onto the request row later — defer until measured.

`model_experiment_request.created_at` and `usage_id` match the linked `microdollar_usage` row exactly. The gateway uses JS-side identity values so the same `usageId`/`createdAt` are written to both usage and experiment-attribution rows without relying on Postgres timestamp text round-tripping.

`model_experiment_request` stores only hashes or reserved sentinel values for prompts, never prompt content. The bodies live in R2, keyed by sha256.

No backfill is required because pre-experiment traffic has no side-table row.

**Partitioning.** `model_experiment_request` is a Postgres declarative-partitioned table partitioned by range on `created_at` (monthly partitions):

- Volume scales with experimented preview traffic, not gated by billing — once a partner experiment runs at production volume, the table grows fastest of any new schema added by this plan.
- Retention drops become `DETACH PARTITION` + `DROP TABLE` (O(1), no bloat) instead of large `DELETE`/`UPDATE` sweeps; the prompt-wipe sentinel update path stays the same but operates on much smaller per-partition working sets.
- The existing access patterns are partition-pruning friendly: every reporting query and the `(variant_version_id, created_at)` index include `created_at`, and the `usage_id` PK / `client_request_id` partial index can be enforced as partitioned indexes (the PK becomes `(usage_id, created_at)` to satisfy the partition-key-in-PK rule, with the FK to `microdollar_usage(id)` retained on `usage_id`).
- The `usage_id → microdollar_usage(id) on delete cascade` FK still works against the partitioned table. PostgreSQL requires the primary key to include the partition key, so the PK is `(usage_id, created_at)`.

Physical shape and maintenance:

1. Drop/recreate the still-empty `model_experiment_request` table as `PARTITION BY RANGE (created_at)` with PK `(usage_id, created_at)` and the same CHECKs/indexes redeclared as partitioned indexes.
2. Create monthly partitions for May, June, and July 2026 in migration `0142_dashing_blue_marvel.sql`.
3. Add `apps/web/src/app/api/cron/model-experiment-request-partition-maintenance/route.ts`, scheduled from `apps/web/vercel.json`, to provision the current month plus two months ahead.
4. Do not create a default partition. If maintenance misses the forward window, attribution inserts fail visibly through the existing best-effort error reporting instead of silently landing in a catch-all partition that needs operational relocation.

This keeps retention drops partition-friendly before partner traffic can grow the table. Ongoing operational requirement: the cron route must keep future partitions provisioned before the current rolling window expires.

### Prompt Storage (R2)

The implemented prompt store uses content-addressed R2 objects referenced by `model_experiment_request.request_body_sha256`. The durable retention and wipe policy is specified in `.specs/model-experiments.md`; this section keeps only implementation-specific notes.

- Env var: `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`.
- Buckets: `kilo-experiment-prompts-dev` and `kilo-experiment-prompts-prod`.
- Helper module: `apps/web/src/lib/r2/experiment-prompts.ts` with `putPromptIfAbsent`, `putPromptOrNull`, `getPromptByHash`, and `sha256Hex`.
- Current capture path: `buildExperimentPromptCapture` serializes the canonical post-transform request body, records `requestKind`, applies the current 4 MB implementation cap, and stores the bounded capture on `MicrodollarUsageContext` for the async `after()` write.
- Write path: `persistExperimentAttribution` stores the prompt body best-effort in R2, then inserts the attribution row with a real hash or reserved sentinel. Prompt-storage failures are reported but do not roll back billing.
- Read path: the admin request browser exposes captured prompt bodies through `apps/web/src/app/admin/api/model-experiments/download/route.ts`, which reads by hash via `getPromptByHash`.

### Phase 2 — Gateway Header Capture

In `apps/web/src/app/api/openrouter/[...path]/route.ts`:

- Capture `x-kilo-request` into `clientRequestId`.
- Capture `x-kilo-session` as a fallback for `session_id` when `x-kilocode-taskid` is absent.
- Reuse the existing machine-id extraction; do not introduce a new header.
- Pass `clientRequestId` through `MicrodollarUsageContext` and persist it in `model_experiment_request` only when an experiment is applied.
- Note on context mutation: `route.ts` calls `getProvider` before constructing `MicrodollarUsageContext`. `getProvider` must therefore return experiment metadata alongside the provider result, and `route.ts` assigns `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, and the bounded prompt capture onto `usageContext` after it is constructed. The existing code already mutates `usageContext` later for fields such as `ttfb_ms`, `status_code`, and `abuse_request_id`; experiment fields follow that route-level mutation pattern rather than mutating context from inside `getProvider`.

### Phase 3 — Variant Picker + Routing

Add `apps/web/src/lib/ai-gateway/experiments/`:

- `membership.ts`
  - `isPublicIdExperimented(publicId)`: fast membership check through `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY`, wrapped by a short in-process cache. The membership value contains every `public_model_id` with `status IN ('active', 'paused')`. If Redis is empty, corrupt, or unavailable, it returns `false` rather than doing a Postgres query for every negative hot-path check.
- `pick-variant.ts`
  - `getRoutingExperimentForPublicId(publicId)`: returns the routing-relevant experiment with its current status (`active` or `paused`) and resolved variant + version data, `null` when Postgres proves there is no routing-relevant experiment, or `unavailable` when database/config failures prevent a safe routing decision. It resolves "current version" per variant via `SELECT DISTINCT ON (variant_id) id, variant_id, upstream, encrypted_api_key, effective_at FROM model_experiment_variant_version WHERE variant_id IN (...) AND effective_at <= now() ORDER BY variant_id, effective_at DESC, id DESC` (Postgres-specific; one query for the experiment, no per-variant round trips). The selected variant's `encrypted_api_key` is decrypted when building the direct provider; plaintext keys are not serialized to Redis.
  - `pickModelExperimentVariant({ publicModelId, userId, machineId, clientIp })`: calls `getRoutingExperimentForPublicId`. Behavior depends on returned experiment status:
    - `active`: pick a variant and return `{ status: 'active', experimentId, variantId, variantVersionId, upstream, allocationSubject }`. If no allocation subject is available (no userId/machineId/clientIp), capture the invariant violation and return `{ status: 'unavailable' }`.
    - `paused`: returns `{ status: 'not-found' }` so the caller can short-circuit with a local 404/model-unavailable response (see Phase 1 routing behavior).
    - `unavailable`: returns `{ status: 'unavailable' }` so the caller can short-circuit with a 503 "temporarily unavailable" response.
    - `null` (no routing-relevant experiment): returns `null` only after Postgres/cache state proves the public id is not currently routed by an experiment.

  Only `variantVersionId` and `allocationSubject` are persisted on the request row; `upstream` is used by `buildDirectProvider` and not snapshotted (the immutable version row is the snapshot).
  - Allocation subject precedence: `userId`, then `machineId`, then `clientIp`; fail closed with `unavailable` when none exist.
  - `userId` MUST be the authenticated `kilocode_users.id` only. Synthetic anonymous identifiers (e.g., `anon:<ip>`) are never passed as `userId` — anonymous traffic falls through to `machineId`, then `clientIp`. Under Dedicated mode v1, experimented public ids are auth-gated, so the vast majority of allocations will use `userId`.
  - Seed format: `model_exp_${experimentId}_${allocationSubject}_${subjectValue}`.
  - Variant selection: `getRandomNumber(seed, sumOfWeights)`, then cumulative weights walked in `ORDER BY model_experiment_variant.id ASC`. Ordering by the immutable `id` (uuid PK), not by `label`, so live label edits never rebucket users. Reports group by `variant_version_id` and don't depend on slot order.

- `build-direct-provider.ts`
  - `buildDirectProvider(upstream)`: returns the same `Provider` shape that `getProvider`'s `kilo-internal/...` branch returns today (`apps/web/src/lib/ai-gateway/providers/get-provider.ts`): `{ id: 'custom', apiUrl: upstream.base_url, apiKey: upstream.api_key, supportedChatApis: inferSupportedChatApis(upstream.opencode_settings?.ai_sdk_provider, upstream.openclaw_settings?.api_adapter), transformRequest }`. The existing `kilo-internal` branch is refactored to call this same builder (passing the relevant fields from the `custom_llm2` row) so both code paths share one implementation. `bypassAccessCheck: true` remains on the `getProvider` result object, not on the `Provider`.

Integration in `getProvider` (`apps/web/src/lib/ai-gateway/providers/get-provider.ts`) and `route.ts`:

- `getProvider` returns optional experiment routing metadata, because `route.ts` constructs `MicrodollarUsageContext` after `getProvider` returns. The experiment branch runs near the top of `getProvider`, after the BYOK branches and **before** the `kilo-internal/...` branch and the `kiloExclusiveModels` lookup. Pseudocode:
  ```ts
  if (await isPublicIdExperimented(requestedModel)) {
    const selection = await pickModelExperimentVariant({
      publicModelId: requestedModel,
      userId,
      machineId,
      clientIp,
    });
    if (selection?.status === 'not-found') {
      return { kind: 'not-found' }; // route.ts maps to local 404 before dereferencing provider
    }
    if (selection?.status === 'unavailable') {
      return { kind: 'unavailable' }; // route.ts maps to temporarilyUnavailableResponse()
    }
    if (selection?.status === 'active') {
      return {
        kind: 'provider',
        provider: buildDirectProvider(selection.upstream),
        userByok: null,
        skipKiloExclusiveModelSettings: true,
        experiment: {
          experimentId: selection.experimentId,
          variantId: selection.variantId,
          variantVersionId: selection.variantVersionId,
          allocationSubject: selection.allocationSubject,
        },
      };
    }
    // selection === null means Postgres/cache state proves this public id is not currently routed by an experiment
  }
  ```
- `getProvider` returns a small route-visible union:
  ```ts
  type GetProviderResult =
    | {
        kind: 'provider';
        provider: Provider;
        userByok: BYOKResult[] | null;
        skipKiloExclusiveModelSettings?: boolean;
        experiment?: {
          experimentId: string;
          variantId: string;
          variantVersionId: string;
          allocationSubject: 'user' | 'machine' | 'ip';
        };
      }
    | { kind: 'not-found' }
    | { kind: 'unavailable' };
  ```
- `route.ts` handles `not-found`/`unavailable` routing results before reading `provider.supportedChatApis`: `not-found` maps to local 404/model unavailable, and `unavailable` maps to 503/temporarily unavailable. For active selections, it constructs `usageContext` as it does today, then copies `providerResult.experiment.variantVersionId`, `allocationSubject`, and `clientRequestId` onto the context. After provider-specific/direct-provider transforms have produced the canonical upstream request body and before any later mutation, it stores `usageContext.experimentPromptCapture = buildExperimentPromptCapture(requestBodyParsed.body)`. The capture is bounded before being retained for the async write.
- Picking inside `getProvider` is required because the upstream `apiUrl/apiKey`, billing metadata, and direct-provider policy flags must be known before `route.ts` runs balance and `checkOrganizationModelRestrictions` checks. This is the same layer where `kilo-internal/...` already integrates.
- Experiment traffic is free/provider-funded for v1 through the async `isFreeModel` path. It does **not** skip server-side organization policy checks: `route.ts` still calls `checkOrganizationModelRestrictions` for experimented public ids, but direct experiment routing refuses request/org policy that only OpenRouter/Vercel can enforce (for example request-level data-collection opt-out or enterprise provider allow-list). `skipKiloExclusiveModelSettings: true` separately prevents registry `internal_id`/provider rewrites from overriding the selected variant.
- `applyProviderSpecificLogic` accepts route metadata that skips only Kilo-exclusive model settings when `skipKiloExclusiveModelSettings` is true. Generic provider-specific request fixes still run, and `provider.transformRequest` still performs the direct experiment rewrite before the upstream fetch.

Routing scope:

- Applies only when the request's resolved public id is in the experimented SET. Under Dedicated mode v1 these are dedicated testing public ids (e.g. `kilo/preview-experiment-foo`) that clients select explicitly.
- `kilo-auto` resolution does not feed experimented public ids by construction: `autoFreeModels` and the frontier preset list are hand-curated, and dedicated preview ids are never added to either. No runtime guard is required (and adding one would force per-candidate Redis membership checks on every `kilo-auto/free` request). The invariant lives in code review of those static lists.
- Does not apply to BYOK requests or `kilo-internal/...` traffic (those branches are matched first / by id prefix and never reach the experiment branch).
- Experimented preview ids are treated as free/provider-funded by `isFreeModel`, so zero-balance and anonymous-free-model gates follow the same path as other free models. Server-side organization allow/deny checks still run against the public model id; direct experiment routing refuses policy that cannot be enforced on a direct partner endpoint.
- Experimented traffic goes **direct to `upstream.base_url`** — OpenRouter and Vercel are never contacted. No gateway pin needed.

### Phase 4 — Usage, Metrics, and Reporting

Persist experiment attribution everywhere request-level metrics are consumed:

- `MicrodollarUsageContext`: add `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, and `experimentPromptCapture`. The picker also returns `variantId` and `experimentId` for in-memory use (debug logs only), but only `variantVersionId` and `allocationSubject` are persisted to `model_experiment_request`. The `upstream` blob is consumed by `buildDirectProvider` and not stored on the context. `experimentPromptCapture` holds the bounded canonical prompt capture used by the prompt-storage path; it never stores the full uncapped request body.
- **Decoupled experiment write.** The microdollar write remains the billing source of truth, and experiment attribution is written as a separate best-effort analytics row. Small `processUsage.ts` changes are allowed if they keep this flow simpler, such as accepting pre-generated `usageId`/`createdAt` or returning the inserted usage identity. Inside the same `after()` hook scheduled by `accountForMicrodollarUsage`, a new step runs `persistExperimentAttribution` (see `apps/web/src/lib/ai-gateway/experiments/persist.ts`) when `usageContext.modelExperimentVariantVersionId` is set. Failure of the experiment write is Sentry-reported but does not roll back the microdollar write (billing must succeed independently of analytics).
- `persistExperimentAttribution` consumes the bounded `experimentPromptCapture` from `MicrodollarUsageContext`. It performs, in order:
  1. `putPromptIfAbsent(request_body_content)` for the bounded full-body capture, returning a sha256 hex digest or `__failed__`.
  2. Insert one row into `model_experiment_request` carrying the attribution columns, `request_kind`, and the resulting prompt hash/sentinel (single statement). On R2 put failure, the attribution row still lands.
- PostHog: no change in v1. `processUsage.ts` does not emit a general per-request PostHog event today, and adding one purely for experiment fields is out of scope. Feedback joins (`Feedback Submitted.parentMessageID = client_request_id`) are queried via existing PostHog dashboards out-of-band, linked from the admin UI.
- Analytics Engine: no v1 work. Adding experiment dimensions to `services/o11y/pipelines/api-metrics-schema.json`, `services/o11y/src/api-metrics-routes.ts`, `apps/web/src/lib/ai-gateway/o11y/api-metrics.server.ts`, `services/o11y/src/o11y-analytics.ts`, the o11y tests, and possibly `services/o11y/wrangler.jsonc` (pipeline stream recreation) is deferred until a concrete AE-backed dashboard needs experiment dimensions. v1 admin reports come from Postgres only.
- Reporting view: `model_experiment_request_stats` is intentionally deferred. The admin request log currently performs the join inline in Drizzle and explicitly selects only non-key columns. Add a view when `getLiveStats` or another aggregate report needs a stable column set; the view must not select `encrypted_api_key` or any plaintext key.
- Provider report template: document per-RC request count, error rate, p50/p95 TTFT and total latency, input/output token aggregates, and unique users. Cost per RC is excluded for v1 per the pricing decision. Thumbs-up/down rate is queried via PostHog dashboards out-of-band, linked from the admin UI.

Reports should group by `variant_version_id` for per-RC attribution. `variant_id` (the slot) and `internal_id` (resolved through the version) are both useful secondary groupings; `variant.label` is a mutable display name only.

### Phase 5 — Admin tRPC + UI

Add `apps/web/src/routers/admin/model-experiments-router.ts` with:

- Experiment methods: `list`, `get`, `create`, `update`, `delete` (draft only), `activate`, `pause`, `complete`, `setArchived(id, archived: boolean)`.
- Variant methods: `addVariant` and `removeVariant` are allowed only on `draft` (structural). `updateVariantLabel` is allowed in any non-terminal state. `swapVariantVersion(variantId, { upstream, apiKey })` is allowed in any non-terminal state (`draft`, `active`, `paused`); validates `upstream` against `ExperimentUpstreamSchema` (strict), calls `encryptApiKey(apiKey, BYOK_ENCRYPTION_KEY)`, and inserts a new `model_experiment_variant_version` row with `effective_at = now()`. `rotateApiKey(variantId, apiKey)` is sugar that calls `swapVariantVersion` with the latest version's `upstream` and the new key. Both reject when `BYOK_ENCRYPTION_KEY` is unset (`INTERNAL_SERVER_ERROR`, mirroring `byok-router.ts:202`). No UPDATE on the variant row is needed — "current version" is derived.
- Guardrails: activation validates `weight > 0` per variant, ≥2 variants, every variant has at least one version with `effective_at <= now()`, and (active|paused) uniqueness per `public_model_id`. Weight or structural edits after activation are rejected; create a new experiment instead. Hot-swap and label edits are the only live mutations. `model_experiment_variant_version` rows are insert-only — no UPDATE or DELETE endpoints. `setArchived(id, true)` rejects when status is `active`.
- Admin response shape: `get(id)` and `list()` MUST NOT return `encrypted_api_key` or any plaintext key. Admin queries explicitly select non-key columns (no `SELECT *`). The UI shows a "configured" indicator + the version's `created_at` as a proxy for last-rotated. Reading raw keys is impossible via tRPC by design; the only consumer of `decryptApiKey` for experiment versions is the gateway route/picker path for the selected variant.
- Cache maintenance for mutations that affect routing states: recompute `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` (`SELECT public_model_id FROM model_experiment WHERE status IN ('active', 'paused')`) and rewrite it as a JSON array string on every transition into or out of (active, paused). Routing details are loaded from Postgres; there is no per-public-id Redis payload cache.
- Paused experiments: gateway returns a local 404/model-unavailable response for requests to the experimented public id. Completed experiments are historical/non-routing and are not included in gateway caches. The not-found mapping lives in `pick-variant.ts`/`getProvider` so the gateway can short-circuit before upstream resolution.
- `getLiveStats(id)`: aggregate recent requests/errors/p50-p95 latency grouped by `variant_version_id`, with `variant.label` and `upstream->>'internal_id'` resolved for display. Token aggregates per RC (input/output) included; `cost_mUsd` excluded for v1 per the pricing decision.
- `getPromptByHash(sha: string): Promise<{ content: string } | null>`: admin-gated tRPC procedure that reads from R2 via `getPromptByHash` (`apps/web/src/lib/r2/experiment-prompts.ts`). Accepts only 64-character lowercase hex hashes and returns `null` if the object doesn't exist. Used by the admin UI to inflate real hashes from `model_experiment_request` rows on demand; sentinel values are rendered without an R2 read. Page-level dedup at the call site: collect distinct real hashes, batch-fetch, join in memory.

Wire the router into `apps/web/src/routers/root-router.ts`.

Add admin pages:

- `apps/web/src/app/admin/model-experiments/page.tsx`
- `apps/web/src/app/admin/model-experiments/[id]/page.tsx`

Use the same admin gate as existing gateway-config pages. For UI work, follow the repo's apps/web UI guidance before implementation. The variant-version editor is a Monaco JSON editor seeded with the `ExperimentUpstreamSchema` shape, modeled on the existing custom-LLM editor (`apps/web/src/app/admin/custom-llms/CustomLlmsContent.tsx:60-277`); the form is narrower (no `organization_ids`, `pricing`, etc.) and `api_key` is masked on read and submitted as a separate field.

### Phase 6 — Specs + Tests

`.specs/model-experiments.md` is now the durable source of truth and is registered in the `AGENTS.md` specs table.

Implemented test coverage includes the core picker, routing, admin state machine/cache maintenance, prompt persistence, partitioning, and soft-delete policy. Remaining targeted coverage is tracked with concrete follow-ups, especially response client-blinding tests in the response-rewrite section below.

## Caching, Privacy, and Logging

The durable privacy, retention, and logging rules now live in `.specs/model-experiments.md`. Implementation-specific note: prompt-cache behavior needed no change because `applyTrackingIds` salts by provider/user/task, while upstream providers key on `(model, cache_key)`, so different internal checkpoints naturally separate caches.

## API Keys

Partner API keys reuse the BYOK encryption primitives and live only in `model_experiment_variant_version.encrypted_api_key`. Admin reads omit that column; routing decrypts only the selected variant version. The non-leakage rule is specified in `.specs/model-experiments.md`.

## Reporting Caveats

The durable reporting caveats are specified in `.specs/model-experiments.md`. Implementation follow-ups remain: add `model_experiment_request_stats`, `getLiveStats`, or Analytics Engine dimensions only when a concrete reporting consumer needs them.

## Risk Areas

- Routing order: variant selection must happen inside `getProvider`, before `route.ts` runs org-model-restriction and direct-routing policy checks. Experiment traffic is treated as free/provider-funded through `isFreeModel`; server-side organization policy checks still run before upstream fetch.
- Client blinding: response rewriting is still tracked below because direct experiment providers currently expose the served upstream `internal_id` in some response shapes.
- R2 prompt-store credential exposure: the same `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` already used by `apps/web/src/lib/r2/client.ts` is reused. Adding an experiment-prompts bucket extends the blast radius of those credentials. Acceptable for v1 because the same trust boundary already covers cli-sessions and cloud-agent-attachments. If/when scoped per-bucket credentials become available cheaply, narrow them.
- Before the first real partner experiment, model-specific opt-in/disclosure must exist as specified in `.specs/model-experiments.md`.

> Partner-specific risks (cross-model session contamination, capture fidelity) are covered in [Part 2](./experimental-models-2.md).

## v1 Exclusions

See `.specs/model-experiments.md` for durable v1 exclusions. Partner trace export, redaction, HMAC webhooks, partner auth, warehouse coordination, replay bundles, SWE-bench/OpenHands adapters, and held-out replay-eval service are covered in [Part 2](./experimental-models-2.md).

## Followup: rewrite checkpoint identity in experiment responses

Experiment routing rewrites the outbound request to the variant's `upstream.internal_id` (in `buildDirectProvider`, applied via `body.model` before the partner fetch), but the response is returned to the client unchanged.

The existing response-rewriting branch in `apps/web/src/app/api/openrouter/[...path]/route.ts:715,733` only runs for `kilo-exclusive` free traffic flowing through OpenRouter or Vercel — experiment providers carry `provider.id === 'custom'` and bypass it. As a result, OpenAI- and Anthropic-shape partner responses echo `internal_id` in the JSON body and in streaming `model:` events, disclosing the served checkpoint and variant to the client.

This violates the client-blinding requirement in `.specs/model-experiments.md`. A user could diff response payloads across requests to deduce their bucket assignment and observe checkpoint hot-swaps.

Fix: rewrite `model` back to the requested `public_id` in experiment responses on the way out, mirroring the existing kilo-exclusive rewrite. Both response shapes need coverage:

- Non-streaming JSON: replace `model` in the parsed body before returning.
- Streaming SSE/event-stream: rewrite the per-chunk `model` field in chat-completions deltas, Anthropic `message_start` / `message_delta` events, and Responses-API `response.created` / `response.completed` events. The existing `rewriteFreeModelResponse_*` helpers in `apps/web/src/lib/ai-gateway/providers/openrouter/responses.ts` (and siblings) already implement this for the gateway-routed path; experiment traffic should reuse the same rewriters keyed on `experiment` rather than provider id, or the predicate at `route.ts:715` should be widened to "rewrite when the served model id differs from the requested public id" so the kilo-exclusive and experiment paths share one rule.

Targeted test: end-to-end an experimented chat-completions and messages request, assert the streamed and final-JSON `model` values match the requested public id and never the variant's `internal_id`.

## Followup: unify direct-upstream routing abstraction

Three routing paths now bypass parts of the OpenRouter policy machinery:
`custom_llm2`, `direct-byok`, and experiments. Each does so through different
flags on `GetProviderProviderResult` (`bypassAccessCheck`, `skipProviderPin`,
`skipKiloExclusiveModelSettings`) and ad-hoc `if (experiment && ...)` policy
refusals in `route.ts` (data collection, provider allow-list).

The proliferation is a symptom of treating each direct-upstream caller as a
special case rather than as instances of one abstraction. A followup PR
should:

- Collapse the per-caller flags into a single notion (e.g. `routingMode:
'gateway' | 'direct'`) on the provider result. `gateway` flows through
  OpenRouter/Vercel and accepts the full `body.provider` policy machinery;
  `direct` does not.
- Move the policy-refusal points (currently `if (experiment && settings?.data_collection === 'deny')`,
  `if (experiment && providerConfig?.only !== undefined)`) into a single
  `checkPolicyEnforcableOnDirect` step that runs for every `direct`-mode
  request and returns the appropriate refusal when the org has explicit
  policy that the gateway can't enforce on a direct partner endpoint.
- Reconsider `custom_llm2`'s `bypassAccessCheck: true`. Today it skips the
  whole org-restrictions block (per the AI Gateway `AGENTS.md`: "enabling
  requires explicit admin action, so the org allow-list doesn't apply").
  That justification holds for per-org admin-enabled custom LLMs but not
  for globally-routed experiment public ids; the unified abstraction
  should make that distinction explicit rather than burying it in flag
  combinations.

This refactor is out of scope for the experiment-routing PR and is tracked
here so the next PR touching the gateway routing surface can address it.

## Files Touched

Core experiment implementation:

- `packages/db/src/schema.ts`
- `packages/db/src/migrations/<generated>_*.sql`
- `apps/web/src/lib/ai-gateway/experiments/pick-variant.ts` (uses `decryptApiKey` from `apps/web/src/lib/ai-gateway/byok/encryption.ts`; no new module)
- `apps/web/src/lib/ai-gateway/experiments/build-direct-provider.ts`
- `apps/web/src/lib/ai-gateway/experiments/persist.ts` (new — owns `buildExperimentPromptCapture`, `persistExperimentAttribution`, size caps, sha256 hashing, R2 puts, and the single-row insert into `model_experiment_request`)
- `apps/web/src/lib/ai-gateway/experiments/membership.ts`
- `apps/web/src/app/api/openrouter/[...path]/route.ts`
- `apps/web/src/lib/ai-gateway/providers/get-provider.ts` (refactor `kilo-internal/...` branch to share `buildDirectProvider`; add experiment branch that returns direct provider plus experiment metadata)
- `apps/web/src/lib/ai-gateway/providers/types.ts` (add the provider-result/experiment metadata types if they do not fit locally in `get-provider.ts`)
- `apps/web/src/lib/ai-gateway/providers/apply-provider-specific-logic.ts` (honor `skipKiloExclusiveModelSettings` while keeping generic request fixes and `provider.transformRequest`)
- `apps/web/src/lib/ai-gateway/llm-proxy-helpers.ts` (extend the existing `after()` hook around `accountForMicrodollarUsage` to also call `persistExperimentAttribution` after the microdollar write completes)
- `apps/web/src/lib/ai-gateway/processUsage.ts` (small identity plumbing only if needed to share or return the inserted `usage_id`/`created_at`)
- `apps/web/src/lib/ai-gateway/processUsage.types.ts` (add `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, `experimentPromptCapture` fields to `MicrodollarUsageContext`)

R2 prompt store:

- `apps/web/src/lib/r2/experiment-prompts.ts` (new — `putPromptIfAbsent`, `getPromptByHash`, sha256 helper)
- `apps/web/src/lib/r2/client.ts` (add `r2ExperimentPromptsBucketName` export reading from `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`)
- Env config: add `R2_EXPERIMENT_PROMPTS_BUCKET_NAME` to local `.env.local`, Vercel project envs (preview + production), and the dev env-sync manifest. Two buckets to provision in Cloudflare R2: `kilo-experiment-prompts-dev` and `kilo-experiment-prompts-prod`.

GDPR test:

- `apps/web/src/lib/user/index.test.ts` (asserts `softDeleteUser` does **not** delete `model_experiment_request` rows or prompt hashes)

Admin and routing:

- `apps/web/src/lib/redis-keys.ts`
- `apps/web/src/routers/admin/model-experiments-router.ts` (CRUD plus request log; `getPromptByHash` still deferred)
- `apps/web/src/routers/root-router.ts`
- `apps/web/src/app/admin/model-experiments/page.tsx`
- `apps/web/src/app/admin/model-experiments/[id]/page.tsx`
- `.specs/model-experiments.md`
- `AGENTS.md`

## Manual Verification After Implementation

- Create and activate a two-variant experiment; verify new requests create `model_experiment_request` rows linked to `microdollar_usage`.
- Send repeated requests for one user and confirm stable variant assignment.
- Send requests across many subjects and confirm empirical split is near configured weights.
- Replace a live variant checkpoint via `swapVariantVersion` (which is a pure INSERT into `model_experiment_variant_version` with `effective_at = now()`); confirm old `model_experiment_request` rows still point at the original `variant_version_id` (resolving to the old `internal_id`) while new rows point at the newly inserted `variant_version_id`.
- Confirm `model_experiment_request.created_at` exactly equals the referenced `microdollar_usage.created_at`.
- Submit feedback from a kilocode client and verify `parentMessageID` joins to `client_request_id`.
- Pause an experiment and confirm requests to the experimented public id return local 404/model unavailable after cache invalidation/TTL.
- Resume a paused experiment and confirm a returning user lands in the same `variant_id` bucket as before the pause.
- Hot-swap during pause: pause, run `swapVariantVersion` (which inserts a new version row with `effective_at = now()`), resume, send a request from a user who was previously bucketed; confirm the bucket (variant_id) is unchanged but the served `variant_version_id`/`internal_id` resolves to the newly inserted version.
- Archive a `completed` experiment; confirm it disappears from default admin lists. Attempt to archive an `active` experiment; confirm the admin call rejects.
- Send an experimented request, then in the admin UI navigate to the experiment's request browser, pick a row, and confirm `request_body_sha256`, `request_kind`, and `was_truncated` display correctly. Verify the dev bucket (`kilo-experiment-prompts-dev`) actually receives the object.
- Send two experimented requests with byte-identical transformed bodies; confirm both rows reference the same `request_body_sha256` and one content-addressed R2 object.
- Pause/resume + hot-swap flow continues to populate prompt rows correctly across the transition.
- Run the prompt-orphan GC sweep against the dev bucket after `UPDATE model_experiment_request SET request_body_sha256 = '__deleted__'`; confirm all orphaned R2 objects are deleted and no production data is touched (separate bucket).
