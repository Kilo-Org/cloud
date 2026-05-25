# Experimental Models — Part 1: Core A/B Experiment System

## Implementation Status (read this first)

<!--
  Update this block when phase status changes. Format:
    [done]       implemented
    [done-core]  core implementation exists; explicit follow-ups remain
    [partial]    some implementation/tests exist; durable work remains
    [todo]       not started
-->

| Phase                               | Status      | Current State                                                                                                                                                                                                                      |
| ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Schema + Migration        | [done]      | Experiment tables exist. `model_experiment_request` is monthly range-partitioned on `created_at`, uses primary key `(usage_id, created_at)`, and stores one full-body prompt hash plus `request_kind`.                             |
| Phase 2 — Gateway Header Capture    | [done]      | Gateway captures `x-kilo-request`, `x-kilo-session`, and `x-kilocode-machineid`, and passes the client request id, session id, machine id, and client IP into routing/usage context.                                               |
| Phase 3 — Variant Picker + Routing  | [done]      | Experimented public ids route through the deterministic picker, load routing details from Postgres after Redis membership pre-check, and go directly to the selected partner upstream.                                             |
| Phase 4 — Usage, Metrics, Reporting | [done-core] | Attribution rows and R2 prompt bodies are written after microdollar usage. Admin request log reads the rows inline. Live aggregate reporting and `model_experiment_request_stats` are deferred until a report consumer needs them. |
| Phase 5 — Admin tRPC + UI           | [done-core] | Admin CRUD, state transitions, variant version hot-swap, key rotation, UI tab, and request log exist. `getLiveStats` and prompt inflation via `getPromptByHash` are still deferred.                                                |
| Phase 6 — Specs + Tests             | [partial]   | Router, picker, prompt persistence, partitioning, and soft-delete policy tests exist. Durable spec file `.specs/model-experiments.md` and AGENTS registration are still owed.                                                      |

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
- `getPromptByHash(sha)` tRPC procedure and admin prompt inflation — R2 helpers exist, but the admin UI renders hashes/sentinels rather than inflating prompt content.

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

### Accepted Design

| Area                   | Decision                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Experiment scope       | One experiment targets one public model id (`public_id`) and swaps the upstream checkpoint (`internal_id`) behind it. Clients keep sending the same public model id.                                                                                                                                                                             |
| Allocation             | N variants with positive integer weights (no sum constraint). Bucketing is deterministic on the first available subject: `kilo_user_id` → `machine_id` → `client_ip`. Missing all allocation subjects is an invariant violation and returns temporarily unavailable.                                                                             |
| Anonymous traffic      | Anonymous / free-tier traffic is bucketed when `machine_id` or IP is available. `machine` and `ip` cohorts are less stable than authenticated `user` cohorts, so every request records `allocation_subject` for reporting filters. A request with no IP is treated as a gateway bug and fails closed.                                            |
| Client blinding        | Variant id is not disclosed to the client. No `x-kilo-experiment`, no `x-kilo-variant`, and no payload field. Provider reports receive aggregate variant/checkpoint labels only.                                                                                                                                                                 |
| Checkpoint replacement | A provider may replace the upstream config (`internal_id`, `base_url`, `api_key`, transforms) on a live variant without ending the experiment, as long as variant slots and weights are unchanged. Users stay pinned to the same variant slot.                                                                                                   |
| Structural edits       | Adding/removing variants or changing weights is allowed only before activation. After activation, structural changes require a new experiment because they shift bucket ranges and corrupt longitudinal cohorts. Hot-swapping a checkpoint is not structural; it is a new `model_experiment_variant_version` row under an existing variant slot. |
| Per-request snapshot   | Experimented requests get one row in `model_experiment_request`, keyed by `usage_id`. That row stores the exact checkpoint selected at routing time. Users are pinned to a variant slot, not necessarily to the same checkpoint forever; if variant A moves from `rc1` to `rc2`, old rows remain attributable to `rc1` and new rows to `rc2`.    |
| Feedback attribution   | Gateway stores `x-kilo-request` as `model_experiment_request.client_request_id`. PostHog `Feedback Submitted.parentMessageID` joins to that value, and the experiment request row carries the variant/checkpoint snapshot.                                                                                                                       |
| Storage                | Experiment definitions and routing details live in Postgres. Gateway hot-path pre-checks use an admin-maintained Redis membership key plus a short in-process cache.                                                                                                                                                                             |

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

Admin-router invariants:

- Active experiments must have at least two variants, each with `weight > 0`. No sum constraint — bucketing uses `getRandomNumber(seed, sumOfWeights)` and cumulative walk; UI shows per-variant share as `weight / sum(weights)`.
- Active experiments must have every variant with at least one `model_experiment_variant_version` row whose `effective_at <= now()`. Future-dated versions don't count toward "ready to route."
- Only one routing-relevant experiment can exist per `public_model_id` at a time, where "routing-relevant" means status in (`active`, `paused`). Enforced by partial unique index `WHERE status IN ('active', 'paused')`. `completed` and `draft` are unconstrained — you can have a completed historical experiment alongside a draft replacement queued up, or multiple completed historicals.
- Variants in any non-terminal state (`draft`, `active`, `paused`) may change `label` (cosmetic) and may receive a new `model_experiment_variant_version` insert (the hot-swap operation).
- Variants may not change `weight` or experiment structure (add/remove) after activation. Structural edits are draft-only; once an experiment has been activated, create a new experiment instead. Hot-swapping a checkpoint is not structural because it inserts a new `model_experiment_variant_version` row under an existing variant slot.
- `model_experiment_variant_version` rows are immutable once created; no UPDATE on `upstream` or any other version field. New RC = new version row.
- Requests with no allocation subject (`userId`, `machineId`, or `clientIp`) are treated as an invariant violation. The picker logs/captures the condition and returns `unavailable` so the route responds with temporarily unavailable instead of assigning a non-random fallback bucket.
- Hot-swap semantics across states: inserting a new version (with `effective_at <= now()`) preserves every user's _bucket_ (the `variant_id` slot is determined by the deterministic seed `model_exp_${experimentId}_${subject}_${value}` and is unaffected) but serves the new RC under that slot. This is true on `draft`, `active`, and `paused` experiments. **Reports MUST group by `variant_version_id` to keep RC-level metrics clean across hot-swaps.** "Same bucket" means "same slot," not "same RC."

Status state machine:

```
draft        ─activate→ active           (validation: ≥2 variants, weight > 0, every variant has ≥1 version with effective_at <= now(), no other (active|paused) per public_id)
active       ─pause→    paused
paused       ─activate→ active           (same validation; users return to same bucket via deterministic seed; if hot-swaps occurred during pause they now serve the new RC under the same slot)
active       ─complete→ completed        (terminal/historical: removed from experiment routing; use paused, not completed, to block traffic temporarily)
paused       ─complete→ completed
draft        ─delete→   (row removed; only allowed on draft)
[no other transitions; completed is intent-terminal]
```

Routing behavior per status:

- `draft`: experiment is invisible to the gateway; requests to the public id route as if no experiment exists.
- `active`: gateway buckets and rewrites per the experiment.
- `paused`: requests to the experimented public id receive a local 404/model-unavailable response. They do **not** silently fall through to default routing — that would deliver unexperimented traffic under a public id whose pricing/availability contract was set up for the experiment.
- `completed`: historical/non-routing. Completed experiments are removed from the routing-relevant index and caches so a completed experiment can coexist with a draft or active replacement on the same `public_model_id`. Do not use `completed` as a traffic-blocking state; keep the experiment `paused` until the preview public id is removed from discovery/routing or a replacement experiment is active.

Archive: `is_archived` is an orthogonal boolean. Archiving hides the experiment from default admin lists but doesn't change routing or status. Archiving an `active` experiment is forbidden (DB-level CHECK + admin-router guard); archive any non-active state freely. Unarchive is allowed.

`model_experiment_request` stores experiment attribution only for requests where an experiment was actually applied, with a direct one-to-one link to the usage row.

Indexes for `model_experiment_request`:

- Primary key / unique reference: `(usage_id, created_at)`. `usage_id` remains the one-to-one FK to `microdollar_usage(id)`.
- `(variant_version_id, created_at)` for per-RC reports (the primary checkpoint-level grouping).
- Partial index on `client_request_id` where not null for feedback joins.

Experiment- and variant-level reports go through join: `request → variant_version → variant → experiment`. The served upstream config is read from `model_experiment_variant_version.upstream` JSONB; reports surface `upstream->>'internal_id'` and (where useful) `upstream->>'base_url'`. **Never select `upstream->>'api_key'` in any reporting view, admin query, or response payload.** If query plans show the join hop is hot, add a covering index or denormalize `variant_id` and/or `experiment_id` onto the request row later — defer until measured.

`model_experiment_request.created_at` and `usage_id` match the linked `microdollar_usage` row exactly. The gateway uses JS-side identity values so the same `usageId`/`createdAt` are written to both usage and experiment-attribution rows without relying on Postgres timestamp text round-tripping.

`model_experiment_request` stores **only hashes or reserved sentinel values** for prompts, never prompt content. The bodies live in R2 (see Prompt Storage below), keyed by sha256. Storing only hashes keeps the Postgres row tiny (~80 bytes overhead beyond the existing attribution columns), keeps PG TOAST out of the picture entirely, and lets the experiment data wipe cleanly without coordinating with the primary datastore.

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

Full canonical post-`transformRequest` request bodies are stored in a dedicated R2 bucket using a **content-addressed** pattern: each unique blob is written once under its sha256 hex digest as the object key, and Postgres event rows reference only the hash. This piggybacks on the existing R2 setup in `apps/web` (`apps/web/src/lib/r2/client.ts` already configures the singleton `S3Client` against R2 via `@aws-sdk/client-s3`).

**Bucket layout: one bucket per environment.**

- New env var: `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`.
- Dev value: `kilo-experiment-prompts-dev`.
- Prod value: `kilo-experiment-prompts-prod`.
- The two buckets are fully isolated — no cross-env keys, no cross-env reads. Set up the same way `R2_CLI_SESSIONS_BUCKET_NAME` and `CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME` are configured today.
- New helper module: `apps/web/src/lib/r2/experiment-prompts.ts`. Exports `putPromptIfAbsent(content: string): Promise<string>` (returns the sha256 used as the object key; uses `HeadObjectCommand` to check existence, then `PutObjectCommand` to upload — same pattern as `copyBlobs` in `apps/web/src/lib/r2/cli-sessions.ts:156`) and `getPromptByHash(sha: string): Promise<string | null>` (read via `GetObjectCommand` + `transformToString()`).

**What is stored in R2:**

- One object per full canonical post-`transformRequest` request body. Object key = sha256 hex of the serialized body. There is no separate system-prompt object in v1; the full transformed body is the source of truth.

**What is stored in Postgres (`model_experiment_request`):**

- The existing attribution columns (`usage_id`, `variant_version_id`, `allocation_subject`, `client_request_id`, `created_at`) plus `request_kind`, `request_body_sha256`, and `was_truncated` on the same row. One row per experimented request, linked one-to-one to `microdollar_usage` by `usage_id` and keyed physically by `(usage_id, created_at)` for partitioning.
- `request_body_sha256` is never null. It contains either a 64-character lowercase sha256 hex digest or a reserved sentinel value.
- Reserved sentinel values:
  - `__failed__`: R2 storage failed. The attribution row still lands.
  - `__deleted__`: prompt reference was intentionally wiped while retaining experiment attribution.
- The table never holds prompt content; prompt fields are small fixed-size additions to the existing attribution row.

**Size caps and truncation.**

- Request-body cap: 4 MB measured as UTF-8 bytes. Beyond this the serialized body is truncated to a deterministic valid-UTF-8 prefix before hashing; `was_truncated = true`.
- 4 MB comfortably exceeds the bytes needed by most current requests while bounding what the async `after()` path retains.
- Caps live as constants in `apps/web/src/lib/ai-gateway/experiments/persist.ts` so they are easy to bump.

**Capture + write path** (capture runs before upstream fetch; R2 writes run inside the same `after()` hook as `accountForMicrodollarUsage`, after the microdollar write):

1. After `applyProviderSpecificLogic` / `provider.transformRequest` has produced the canonical upstream request body, call `buildExperimentPromptCapture(requestBodyParsed.body)` before `upstreamRequest`.
2. `buildExperimentPromptCapture` serializes the full request body, records `requestKind`, applies the 4 MB cap, and returns only the bounded string plus `was_truncated`.
3. Store that bounded prompt capture on `MicrodollarUsageContext`; do **not** retain a `structuredClone` of the full uncapped request body through the async `after()` path.
4. In the `after()` hook, compute sha256 and call `putPromptIfAbsent(content)` which `HEAD`s and only `PUT`s on miss.
5. Insert one row in `model_experiment_request` with the attribution columns, `request_kind`, and the resulting prompt hash or sentinel (single statement, single round-trip).

- Prompt storage is best-effort analytics. Use the sha256 for a successful put/already-existing object and `__failed__` when R2 write fails. Log/capture the failure without prompt content. The `model_experiment_request` attribution row still lands when the microdollar usage row exists.

**Read path** (out-of-band, never on the request hot path):

- New tRPC procedure `admin.modelExperiments.getPromptByHash(sha: string): Promise<{ content: string } | null>` that reads via `getPromptByHash`. Admin-gated, same gate as the rest of the experiment admin surface. It accepts only 64-character lowercase hex hashes; sentinel values are rendered by the caller without touching R2.
- For partner export / partner replay (Part 2), the same `getPromptByHash` is used to materialize blobs into the export bundle.
- Page-level dedup at read time: collect distinct hashes per result page, batch-fetch, join in memory.

**GDPR and consent.**

- Prompts collected for model experiments are treated as user-authorized experiment data submitted under explicit opt-in to the dedicated preview/experiment model, not as part of the default PII dataset governed by `microdollar_usage_metadata` soft-delete.
- The opt-in copy for each preview model must disclose that prompts may be retained for experiment analysis and partner evaluation, and that users are responsible for not submitting PII, secrets, customer data, or other sensitive content they do not want retained under that experiment policy. v1 must not run a real partner experiment until that model-specific opt-in/disclosure exists.
- Prompts collected under experiment opt-in use a dedicated experiment retention policy and are not governed by the default `microdollar_usage_metadata` soft-delete policy.
- Concretely: `softDeleteUser` does **not** delete `model_experiment_request` rows and does **not** delete the referencing R2 objects. The `on delete cascade` on `usage_id` only fires if the underlying `microdollar_usage` row is hard-deleted (which `softDeleteUser` does not do today). A dedicated experiment-data wipe path removes prompt references by setting prompt hash columns to `__deleted__`, then relying on R2 GC for blob cleanup.
- The spec documents this explicitly as the policy. A test in `apps/web/src/lib/user/index.test.ts` locks the policy in code: after `softDeleteUser` runs, an experiment-attributed user's `model_experiment_request` row and `request_body_sha256` are still present.

**Wipe semantics.**

- `TRUNCATE model_experiment_request` is independent of `microdollar_usage` and safe to run; this also drops attribution. To wipe only prompts while keeping attribution, run `UPDATE model_experiment_request SET request_body_sha256 = '__deleted__'` (optionally scoped to specific experiments).
- After wiping rows or replacing hashes with sentinels, R2 objects are orphaned. Run a periodic GC sweep (cron / one-off) that lists the bucket and deletes any object whose key does not appear in the distinct set of hash columns filtered to 64-character lowercase hex values.
- Deleting an entire experiment's prompts: `UPDATE model_experiment_request SET request_body_sha256 = '__deleted__' WHERE variant_version_id IN (...experiment's versions...)`, then run the GC sweep. To also drop attribution, `DELETE FROM model_experiment_request WHERE variant_version_id IN (...)` first.
- Automatic retention-window enforcement is not part of v1. The schema makes it a straightforward follow-up: a scheduled job can select experiment request rows by `created_at` and experiment-specific retention policy, replace real prompt hashes with `__deleted__`, and then rely on the same R2 orphan GC to remove unreferenced blobs.

**Why R2 (not KV, not Vercel Blob, not Postgres).**

- **R2** is already used elsewhere in `apps/web` (cli-sessions, cloud-agent-attachments). Same `S3Client`, same credential type, same env-var pattern.
- **R2 storage cost** ($0.015/GB-mo) is ~33× cheaper than Cloudflare KV ($0.50/GB-mo) at this access pattern (write-once, read rarely, no edge-distribution benefit). KV is optimized for hot, small, globally-replicated config data — the wrong shape for bulk prompt blobs.
- **Vercel Blob** is ~3× more expensive than R2 at this workload and adds another vendor surface.
- **Postgres** would also work and is functionally free at v1 scale, but offloading multi-MB blobs to R2 keeps the primary DB lean (no TOAST traffic on hot paths) and gives a clean independent retention/wipe knob from the start. The "swap to R2 later" migration is avoided.

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

Add `.specs/model-experiments.md` and register it in the `AGENTS.md` specs table. The spec should be the durable source of truth for scope, bucketing, mutability, telemetry fields, feedback joins, caching behavior, client blinding, anonymous allocation caveats, the reporting caveats listed above (intended-vs-served-checkpoint single-shot assumption, message-level `COUNT(DISTINCT client_request_id)` rule, error-rate undercount), and v1 exclusions.

Targeted tests:

- Variant picker determinism by `userId`, `machineId`, and `clientIp`.
- Allocation-subject precedence and recorded `allocationSubject`.
- Weighted distribution sanity and bucket-boundary behavior.
- Null return when no routing-relevant experiment exists; not-found return when the experiment is paused; unavailable return when no allocation subject exists on an active experiment.
- End-to-end gateway integration for an experimented public id: assert the upstream `fetch` URL starts with the variant's `upstream.base_url` (NOT OpenRouter or Vercel), `Authorization` header carries `Bearer ${upstream.api_key}`, and `body.model` equals `upstream.internal_id`.
- Usage persistence creates a `model_experiment_request` row with `usage_id`, `variant_version_id`, `allocation_subject`, and `client_request_id`.
- Hot-swap test: `swapVariantVersion` inserts a new `model_experiment_variant_version` row with a different `upstream` (different `internal_id` and/or `base_url`), the picker (after cache invalidation) resolves to the new version, and old `model_experiment_request` rows still resolve through their old `variant_version_id` to the original `upstream`.
- Two-variant routing: distinct seeds bucket to distinct variants, each request lands on the corresponding variant's `upstream.base_url`.
- Tiebreaker test: two `swapVariantVersion` calls landing at the same millisecond produce two version rows; "current" is determined by `(effective_at desc, id desc)` deterministically.
- `model_experiment_request.created_at` exactly matches the referenced `microdollar_usage.created_at`.
- Admin activation validation, active-experiment uniqueness, cache invalidation, and live-edit restrictions.
- State machine: every allowed transition succeeds, every disallowed transition returns a clear error. `setArchived(activeId, true)` rejects.
- Paused experiment requests to the experimented public id return a local 404/model-unavailable response and do not reach upstream. Completed experiments are absent from routing caches; verify completion removes the public id from `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` unless another active/paused experiment for that id exists.
- Anonymous request with machine id is bucketed; request with no allocation subject returns temporarily unavailable and does not reach upstream; BYOK request to a non-experimented id is unaffected.
- API key never leaks: `getLiveStats`, `list`, `get`, `listRequests`, and any future reporting view never return `encrypted_api_key` or any plaintext form. Snapshot test on JSON responses; SQL-level test if/when `model_experiment_request_stats` is added.
- Encryption round-trip: a key submitted via `swapVariantVersion`/`rotateApiKey` is stored as `EncryptedData` JSONB, is decrypted correctly by the gateway picker/provider path, and the resulting plaintext is what reaches `buildDirectProvider` as `apiKey` (assert via mock `fetch` capturing the `Authorization` header).
- Rotation: `rotateApiKey` inserts a new version row, subsequent routing uses the new key, and old request rows still resolve to the prior version (with the old encrypted key intact in the DB).
- Missing `BYOK_ENCRYPTION_KEY`: `swapVariantVersion`/`rotateApiKey` reject; `getRoutingExperimentForPublicId` returns `unavailable` for active/paused experiments and the route returns "temporarily unavailable" instead of falling through.
- Bypass routing: an experimented public id never produces a `fetch` against OpenRouter (`openrouter.ai`) or the Vercel AI gateway, regardless of `shouldRouteToVercel` state.
- Membership key maintenance: activating/pausing/completing an experiment correctly adds/removes its `public_model_id` from `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY`.
- Custom-LLM regression: existing `kilo-internal/...` traffic still routes correctly via the refactored `buildDirectProvider` helper.
- Prompt storage write path: an experimented request produces exactly one row in `model_experiment_request`, with `request_kind` and `request_body_sha256` populated as either a real 64-character hash or reserved sentinel. Real hashes point to R2 objects with content matching the canonical post-`transformRequest` bytes.
- Content-addressing dedup: two requests with byte-identical transformed bodies produce two `model_experiment_request` rows pointing at the same real `request_body_sha256`, and the final R2 object content is correct. Do not assert an exact `PUT` count because concurrent `HEAD`/`PUT` calls can race harmlessly.
- Prompt write decoupling: simulating an R2 `PUT` failure does not roll back the `microdollar_usage` write; the `model_experiment_request` row still lands with `__failed__`, and Sentry is notified.
- Truncation: a serialized request body exceeding 4 MB of UTF-8 is truncated deterministically to valid UTF-8, the resulting hash is stable across runs, and `was_truncated = true` is recorded.
- `getPromptByHash` admin tRPC procedure returns the original content for a known hash and `null` for an unknown hash; sentinel values are rejected or handled before the tRPC call, and non-admin callers are rejected.
- Soft-delete policy: after `softDeleteUser` runs against a user who participated in an experiment, that user's `model_experiment_request` rows are still present, including `request_body_sha256`. (Locks the consent-based retention policy in code.)

## Caching, Privacy, and Logging

- Prompt-cache behavior needs no change. `applyTrackingIds` salts by provider/user/task, while upstream providers key on `(model, cache_key)`, so different internal checkpoints naturally separate caches.
- `model_experiment`, `model_experiment_variant`, `model_experiment_variant_version`, and `model_experiment_request` hold no direct PII.
- The prompt-hash column on `model_experiment_request` and the R2 prompt bucket together hold user-authorized experiment data. The opt-in disclosure places responsibility on users not to submit PII, secrets, customer data, or other sensitive content they do not want retained for experiment analysis or partner evaluation. Retention is governed by explicit experiment opt-in and the dedicated experiment retention policy, not the default `microdollar_usage_metadata` soft-delete policy (see Prompt Storage > GDPR and consent). Automatic retention-window enforcement is a follow-up, not v1. The policy is locked in by a test in `apps/web/src/lib/user/index.test.ts` asserting that `softDeleteUser` does not delete experiment attribution rows or prompt hashes.
- `client_request_id` is opaque and per-message. It is joinable to user activity through `model_experiment_request.usage_id`. The `on delete cascade` on `usage_id` only fires for hard deletes of `microdollar_usage`, which `softDeleteUser` does not perform.
- Do not log full request bodies for experimental traffic into `api_request_log`. The dedicated R2 prompt store is the only persistence mechanism for experiment prompt content; `api_request_log` remains allowlist-only and unrelated to experiments.
- Do not put `client_request_id` or experiment fields into Sentry input payloads; keep them to usage/metrics storage.
- `upstream.api_key` MUST never be logged, returned by tRPC reads, included in error messages, included in Sentry breadcrumbs, or persisted outside the encrypted JSONB column. See "API Keys" section.

## API Keys

The partner-issued upstream API key for each variant version is handled with the same primitives as BYOK keys.

- **Encryption helper.** Reuses `encryptApiKey` / `decryptApiKey` from `apps/web/src/lib/ai-gateway/byok/encryption.ts:12,47` (Node `crypto` AES-256-GCM, 12-byte random IV, 256-bit key from `BYOK_ENCRYPTION_KEY` env var via `apps/web/src/lib/config.server.ts:93`). No new encryption module, no new env var.
- **Storage.** Sibling column on `model_experiment_variant_version`: `encrypted_api_key jsonb not null`, typed as `EncryptedData` (`packages/db/src/schema-types.ts:374`). Identical to `byok_api_keys.encrypted_api_key`. Not stored inside the `upstream` JSONB so that "never read the key" can be enforced at the column level (reporting view, admin response shapers, and Drizzle selects can simply omit it).
- **Decryption point: selected variant only.** The routing path loads encrypted version rows and decrypts the selected variant's `encrypted_api_key` when building the direct upstream provider. Redis membership never contains plaintext partner keys. `BYOK_ENCRYPTION_KEY` is required by server config; if key-touching code cannot decrypt, routing fails closed with "temporarily unavailable" rather than falling through.
- **Hard never-read via admin APIs.** No tRPC endpoint returns the plaintext or ciphertext to the client. The admin UI shows only a "configured" indicator and the version's `created_at` (effectively last-rotated). To rotate, you submit a new key — you cannot retrieve the existing one. This matches BYOK behavior.
- **Rotation = new version insert.** A `rotateApiKey(variantId, newApiKey)` mutation inserts a new `model_experiment_variant_version` row with the same `upstream` blob and a freshly encrypted `encrypted_api_key`, `effective_at = now()`. No special UPDATE path. Version rows are immutable — no exception for keys.
- **Admin gate.** Same gate as gateway-config / custom-llms admin pages. No dedicated role or two-person review for v1.
- **Audit trail.** None beyond `model_experiment_variant_version.created_by` + `created_at`. Adding a dedicated audit log is deferred until compliance asks.
- **Never logged or exported.** Excluded from tRPC responses, any future `model_experiment_request_stats` reporting view, Sentry breadcrumbs/payloads, upstream-error normalization (strip `Authorization` from any echoed request context), Drizzle query logs (ensure no `SELECT *` admin queries against this table), and Part 2 partner trace exports (allowlist-only — explicit test).
- **Historical retention.** Old version rows keep their old `encrypted_api_key`. The key remains in the DB indefinitely. If a partner revokes a key after rotation, the ciphertext is still recoverable from a DB dump in principle; v1 accepts this. A future `tombstoneVersionKey(versionId)` mutation can null/replace the column for compliance — out of scope here.

## Reporting Caveats

These constraints exist because of how the gateway is built today. The spec must document them so report consumers (and providers) interpret numbers correctly.

- **Intended vs served checkpoint.** The gateway is single-shot: no upstream retry, no model fallback, and the upstream `base_url` + `internal_id` are bound once at provider-resolution time. Therefore the upstream config resolved through `model_experiment_request.variant_version_id → model_experiment_variant_version.upstream` reflects both the intended and the served checkpoint. If gateway-level retry/fallback across upstreams is ever introduced, this assumption breaks and `model_experiment_request` would need a served-upstream snapshot column (or a separate served-version FK).
- **Message-level dedup.** `client_request_id` is `MessageV2.User.id` from the kilocode client (`kilocode/packages/opencode/src/session/llm.ts` L407) — stable across all HTTP attempts and tool-loop iterations within a single user message. Message-level reports (per-message thumbs-up rate, error rate per user message, etc.) MUST use `COUNT(DISTINCT client_request_id)` for the denominator to avoid inflating numbers when an agentic turn produces many gateway calls under one user message.
- **Error-rate undercount (accepted v1 limitation).** `model_experiment_request` is written only after the linked `microdollar_usage` row exists. Today `microdollar_usage` is _not_ written for several failure modes, so those failures will be **invisible in experiment reports**:
  - `fetch` throws (DNS, connection reset) — error bubbles out before `after()`.
  - 10-minute upstream timeouts and client-cancelled requests — same path.
  - Upstream 402 remapped to "temporarily unavailable" (`route.ts` ~L568–581 returns before usage accounting).
  - Upstream 5xx with null body or non-streaming with non-JSON body.
  - Streaming 5xx with any body, and 4xx with parseable body, _do_ produce a row with `has_error=true` and zero tokens.

  v1 accepts this and documents it: experiment error-rate reports systematically undercount the worst failure modes (timeouts, fetch errors, 402, null-body 5xx). For early-development checkpoints, supplement experiment reports with upstream alerting and Sentry on the relevant `inference_provider`. A future iteration may move `model_experiment_request` to a two-phase write (insert eagerly after variant selection, update with `usage_id` later) to capture all failures, or fix `microdollar_usage` to always write on error; both are out of scope here.

- **No Analytics Engine dimensions in v1.** The o11y pipeline (`services/o11y`) does not get experiment dimensions in v1. Any AE-backed dashboard (Grafana etc.) will not slice by experiment/variant/RC. Admin reporting is Postgres-only through inline Drizzle queries today; add `model_experiment_request_stats` when a real aggregate consumer appears. If/when a real AE consumer appears, a follow-up adds the fields to `api-metrics-schema.json`, `api-metrics-routes.ts`, `api-metrics.server.ts`, `o11y-analytics.ts`, the o11y tests, and (likely) recreates the pipeline stream via `wrangler.jsonc`.

## Risk Areas

- Routing order: variant selection must happen inside `getProvider`, before `route.ts` runs org-model-restriction and direct-routing policy checks. Experiment traffic is treated as free/provider-funded through `isFreeModel`; server-side organization policy checks still run before upstream fetch.
- Historical attribution: reports must group by `model_experiment_request.variant_version_id` (immutable FK to the exact RC served) and resolve `upstream` through the version row. Never compute "current version of variant X" as part of a historical report; that's mutable.
- Anonymous allocation stability: `machine` and `ip` cohorts are lower-confidence than `user`; reports must expose/filter by `allocation_subject`. Identifier-less traffic is not routed or recorded; it fails closed as temporarily unavailable.
- Structural edits: weight/add/remove operations are only legal on `draft` experiments. Once activated, structural changes require a brand-new experiment — there is no `paused → draft` transition because data collected under one bucket layout cannot be carried over to a different one. Hot-swap (new RC under existing slot) is not structural and is allowed in any non-terminal state.
- Cache invalidation: admin mutations that affect routing must keep `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` in sync with active/paused experiments. Routing details are loaded from Postgres after the membership pre-check; plaintext API keys are not cached in Redis.
- API key handling: see dedicated section.
- Provider blinding: provider-facing exports must not include `kilo_user_id` or user-identifying fields.
- R2 prompt-store credential exposure: the same `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` already used by `apps/web/src/lib/r2/client.ts` is reused. Adding an experiment-prompts bucket extends the blast radius of those credentials. Acceptable for v1 because the same trust boundary already covers cli-sessions and cloud-agent-attachments. If/when scoped per-bucket credentials become available cheaply, narrow them.
- Prerequisite (before first real partner experiment): model-specific opt-in/disclosure that tells users prompts may be retained for experiment analysis and partner evaluation. Flagged in the spec under "Prerequisites."

> Partner-specific risks (cross-model session contamination, capture fidelity) are covered in [Part 2](./experimental-models-2.md).

## v1 Exclusions

- Per-variant pricing. Variants under one `public_id` share current public-id pricing.
- BYOK traffic.
- Custom LLM traffic (`kilo-internal/...`).
- Identifier-less traffic; under v1 such requests fail closed as temporarily unavailable because missing IP is treated as a gateway invariant violation.
- A/B variants spanning entirely different public model ids.
- Client-visible variant ids or variant-aware UI behavior.
- Response-side rewriting of the served `internal_id` back to the requested `public_id` for experiment traffic — see "Followup: rewrite checkpoint identity in experiment responses" below.
- Partner trace export, redaction, HMAC webhooks, partner auth, and warehouse coordination (see [Part 2](./experimental-models-2.md)).
- Replay bundles, SWE-bench/OpenHands adapters, and held-out replay-eval service (see [Part 2](./experimental-models-2.md)).

## Followup: rewrite checkpoint identity in experiment responses

Experiment routing rewrites the outbound request to the variant's `upstream.internal_id` (in `buildDirectProvider`, applied via `body.model` before the partner fetch), but the response is returned to the client unchanged.

The existing response-rewriting branch in `apps/web/src/app/api/openrouter/[...path]/route.ts:715,733` only runs for `kilo-exclusive` free traffic flowing through OpenRouter or Vercel — experiment providers carry `provider.id === 'custom'` and bypass it. As a result, OpenAI- and Anthropic-shape partner responses echo `internal_id` in the JSON body and in streaming `model:` events, disclosing the served checkpoint and variant to the client.

This violates the client-blinding requirement from the Accepted Design ("Clients keep sending the same public model id" — line 112) and from the spec ("client blinding" — `Phase 6 — Specs + Tests`). A user could diff response payloads across requests to deduce their bucket assignment and observe checkpoint hot-swaps.

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
