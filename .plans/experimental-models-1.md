# Experimental Models — Part 1: Core A/B Experiment System

## Implementation Status (read this first)

<!--
  Update this block when phases land. Format:
    [done]  in main, with PR/commit ref
    [merged-pending] PR open, awaiting merge
    [in-progress] partially landed, see notes
    [todo] not started
-->

| Phase                               | Status        | Notes                                                                                                                                   |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Schema + Migration        | [done]        | Migration `0134_black_union_jack.sql` in main. PR #3299.                                                                                |
| Phase 2 — Gateway Header Capture    | [todo]        |                                                                                                                                         |
| Phase 3 — Variant Picker + Routing  | [todo]        |                                                                                                                                         |
| Phase 4 — Usage, Metrics, Reporting | [todo]        |                                                                                                                                         |
| Phase 5 — Admin tRPC + UI           | [in-progress] | Branch `mark/experimental-models-admin`. tRPC router + UI tab landed; `getLiveStats` and `getPromptByHash` deferred to Phase 4/R2 work. |
| Phase 6 — Specs + Tests             | [todo]        | Spec file `.specs/model-experiments.md` not yet created.                                                                                |

**Phase 1 — concrete output (landed in `packages/db/src/schema.ts` + `0134_black_union_jack.sql`):**

- `model_experiment` table with partial unique index on `public_model_id` where status in (`active`, `paused`), status CHECK, and "active not archived" CHECK.
- `model_experiment_variant` table with `(experiment_id, label)` unique constraint and `weight > 0` CHECK.
- `model_experiment_variant_version` table with `(variant_id, effective_at desc)` index. `upstream` is plain `jsonb` (validation by `ExperimentUpstreamSchema` in app code, not yet written). `encrypted_api_key` is `jsonb` typed `EncryptedData` (matches `byok_api_keys.encrypted_api_key`).
- `model_experiment_request` table with `usage_id` PK FK to `microdollar_usage(id) on delete cascade`, `(variant_version_id, created_at)` index, partial index on `client_request_id` where not null, allocation-subject CHECK, and sha256/sentinel format CHECKs for both prompt hash columns.
- Drizzle types exported: `ModelExperiment` / `New…`, `ModelExperimentVariant` / `New…`, `ModelExperimentVariantVersion` / `New…`, `ModelExperimentRequest` / `New…`.

**Not yet done in Phase 1 (still owed by future PRs):**

- ~~`ExperimentUpstreamSchema` zod schema (lives in app code, not in `packages/db`).~~ Landed with Phase 5 admin work in `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts`.
- The `model_experiment_request_stats` reporting view (Phase 4).

**Phase 5 — concrete output (in PR — see status table for branch/PR):**

- `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts` — `ExperimentUpstreamSchema` (strict subset of `CustomLlmDefinitionSchema`, no `api_key`, no `extra_headers`).
- `apps/web/src/lib/redis-keys.ts` — `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` and `modelExperimentRedisKey(publicId)` helpers (used by Phase 3 gateway code, also by admin cache invalidation on every routing-affecting mutation).
- `apps/web/src/lib/redis.ts` — added `redisDel(key)` helper.
- `apps/web/src/routers/admin/model-experiments-router.ts` — full CRUD + state machine (`activate`, `pause`, `complete`, `setArchived`, `delete`-on-draft) + variant ops (`addVariant`, `removeVariant`, `updateVariantLabel`, `swapVariantVersion`, `rotateApiKey`). All routing-affecting mutations invalidate per-public-id cache and recompute the membership set. `encrypted_api_key` is **never** selected by `list`/`get`/`swapVariantVersion`/`rotateApiKey` — admin response shapers explicitly enumerate non-key columns. `BYOK_ENCRYPTION_KEY` missing → `INTERNAL_SERVER_ERROR` on key-touching ops.
- Wired into `apps/web/src/routers/admin-router.ts` as `trpc.admin.modelExperiments.*`.
- `apps/web/src/app/admin/api/model-experiments/hooks.ts` — react-query hooks for every procedure.
- `apps/web/src/app/admin/model-experiments/ModelExperimentsContent.tsx` — list + detail (inline) + create dialog + add-variant dialog + Monaco-based hot-swap dialog (validates `ExperimentUpstreamSchema` strict before submit) + rotate-key dialog. Status badges, share = `weight / sum(weights)`, structural-edit lock for non-draft.
- `apps/web/src/app/admin/gateway/page.tsx` — added "Model Experiments" as the fourth tab inside `/admin/gateway`.
- `apps/web/src/app/admin/model-experiments/page.tsx` — redirects to `/admin/gateway?tab=model-experiments` (mirrors `custom-llms`).

**Phase 5 — deferred (still owed by later PRs):**

- `getLiveStats(id)` tRPC procedure — needs `model_experiment_request` rows (Phase 4 wiring) before it returns anything useful. UI placeholder not yet wired.
- `getPromptByHash(sha)` tRPC procedure — needs the R2 `experiment-prompts` helper module (Phase 1 prompt-storage section, gated on env-var/bucket setup). Admin UI surface for inflating prompts not yet built.

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
| Storage                | Experiment definitions live in Postgres. Gateway hot-path reads use a short Redis cache invalidated by admin mutations.                                                                                                                                                                                                                          |

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
  │    │    │    ├─ load active experiment for publicModelId (Redis-cached, includes each variant's resolved current version: variant_version_id + upstream blob)
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
  usage_id                        uuid pk fk → microdollar_usage(id) on delete cascade
  variant_version_id              uuid not null fk → model_experiment_variant_version(id)
  allocation_subject              text not null -- user | machine | ip
  client_request_id               text nullable
  system_prompt_sha256            text not null  -- 64-char R2 object key, or reserved sentinel (see Prompt Storage)
  request_body_sha256             text not null  -- 64-char R2 object key, or reserved sentinel (see Prompt Storage)
  was_truncated                   boolean not null default false
  created_at                      timestamp not null
  check system_prompt_sha256 is one of: 64-char lowercase hex, __absent__, __failed__, __deleted__
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

The `api_key` is **not** part of `ExperimentUpstreamSchema` and **not** stored in the JSONB blob. It lives in the sibling `encrypted_api_key` column (same `EncryptedData` JSONB shape as `byok_api_keys.encrypted_api_key`) and is merged into the in-memory upstream record only at cache-build time. This makes "never select the key" enforceable at the SQL/column level and allows column-level grants if we ever want them.

`ExperimentUpstreamSchema` deliberately does not include arbitrary `extra_headers` in v1. Partner checkpoint routing should use the encrypted `api_key`, `base_url`, `internal_id`, adapter settings, `extra_body`, and `remove_from_body`. If a provider later requires a non-secret custom header, add an explicit allowlisted field for that concrete requirement rather than reopening arbitrary header storage.

Fields deliberately **not** included (and why): `organization_ids` (the experimented public id is registered in `kiloExclusiveModels` and gates org access there); `pricing` (per-RC pricing is not used in v1); `display_name` / `context_length` / `max_completion_tokens` (these belong on the public id, identical across variants).

`model_experiment_variant` is the slot identity (label, weight, allocation share). `model_experiment_variant_version` is the immutable RC instance held by that slot at a point in time. Hot-swapping an RC is a pure INSERT into `model_experiment_variant_version`; the variant row is not modified. The "current version of variant V at time T" is computed as `SELECT ... FROM model_experiment_variant_version WHERE variant_id = V AND effective_at <= T ORDER BY effective_at DESC, id DESC LIMIT 1` (id used as deterministic tiebreaker for ties at the same millisecond). In practice the picker reads this from the Redis-cached experiment definition (computed once when the cache is built per publicId), not on every request. Old version rows are never modified or deleted, so per-request attribution stays exact via the `variant_version_id` FK on `model_experiment_request` with no snapshot columns and no date-comparison joins. `experiment_id` is reachable via `variant_version_id → variant_id → experiment_id`; storing it on the request row would be denormalization, omitted unless query plans show it's needed.

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

- Primary key / unique reference: `usage_id`.
- `(variant_version_id, created_at)` for per-RC reports (the primary checkpoint-level grouping).
- Partial index on `client_request_id` where not null for feedback joins.

Experiment- and variant-level reports go through join: `request → variant_version → variant → experiment`. The served upstream config is read from `model_experiment_variant_version.upstream` JSONB; reports surface `upstream->>'internal_id'` and (where useful) `upstream->>'base_url'`. **Never select `upstream->>'api_key'` in any reporting view, admin query, or response payload.** If query plans show the join hop is hot, add a covering index or denormalize `variant_id` and/or `experiment_id` onto the request row later — defer until measured.

`model_experiment_request.created_at` and `usage_id` match the linked `microdollar_usage` row exactly. The implementation may either pre-generate those values before the microdollar write or have the microdollar write return them; choose the smaller change in the current `processUsage.ts` flow.

`model_experiment_request` stores **only hashes or reserved sentinel values** for prompts, never prompt content. The bodies live in R2 (see Prompt Storage below), keyed by sha256. Storing only hashes keeps the Postgres row tiny (~80 bytes overhead beyond the existing attribution columns), keeps PG TOAST out of the picture entirely, and lets the experiment data wipe cleanly without coordinating with the primary datastore.

No backfill is required because pre-experiment traffic has no side-table row.

### Prompt Storage (R2)

Full request prompts (system message + canonical post-`transformRequest` body) are stored in a dedicated R2 bucket using a **content-addressed** pattern: each unique blob is written once under its sha256 hex digest as the object key, and Postgres event rows reference only the hash. This piggybacks on the existing R2 setup in `apps/web` (`apps/web/src/lib/r2/client.ts` already configures the singleton `S3Client` against R2 via `@aws-sdk/client-s3`).

**Bucket layout: one bucket per environment.**

- New env var: `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`.
- Dev value: `kilo-experiment-prompts-dev`.
- Prod value: `kilo-experiment-prompts-prod`.
- The two buckets are fully isolated — no cross-env keys, no cross-env reads. Set up the same way `R2_CLI_SESSIONS_BUCKET_NAME` and `CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME` are configured today.
- New helper module: `apps/web/src/lib/r2/experiment-prompts.ts`. Exports `putPromptIfAbsent(content: string): Promise<string>` (returns the sha256 used as the object key; uses `HeadObjectCommand` to check existence, then `PutObjectCommand` to upload — same pattern as `copyBlobs` in `apps/web/src/lib/r2/cli-sessions.ts:156`) and `getPromptByHash(sha: string): Promise<string | null>` (read via `GetObjectCommand` + `transformToString()`).

**What is stored in R2:**

- One object per unique system message (`messages[0]` when its role is `system`). Object key = sha256 hex of the raw content. Same content from a thousand requests = one R2 object. This is where dedup pays off massively (system prompts are byte-stable across requests within a client version, often 50–200 KB).
- One object per request_body remainder: the canonical post-`transformRequest` body with the system message removed (i.e. `{ ...body, messages: body.messages.filter(m => m.role !== 'system') }` when there is exactly one system message; otherwise the full `messages` array is retained as-is). Object key = sha256 hex. Dedup is incidental for this blob (each request's tail is mostly unique), but storing it in R2 alongside the system blob keeps the storage backend uniform and avoids PG TOAST entirely.

**What is stored in Postgres (`model_experiment_request`):**

- The existing attribution columns (`usage_id`, `variant_version_id`, `allocation_subject`, `client_request_id`, `created_at`) plus `system_prompt_sha256`, `request_body_sha256`, `was_truncated` on the same row. One row per experimented request, keyed on `usage_id`.
- Hash columns are never null. They contain either a 64-character lowercase sha256 hex digest or a reserved sentinel value.
- Reserved sentinel values:
  - `__absent__`: only valid for `system_prompt_sha256`; the request had no leading system message.
  - `__failed__`: the corresponding prompt blob existed, but R2 storage failed. The attribution row still lands.
  - `__deleted__`: prompt reference was intentionally wiped while retaining experiment attribution.
- The table never holds prompt content; prompt fields are small fixed-size additions to the existing attribution row.

**Size caps and truncation.**

- `system` content cap: 4 MB. Beyond this the content is truncated to a deterministic prefix before hashing; `was_truncated = true`.
- Non-system body cap: 4 MB serialized JSON. Beyond this the longest individual message is tail-truncated until the total fits, then re-serialized and hashed; `was_truncated = true`.
- 4 MB on each side comfortably exceeds the bytes needed by any current frontier model with a 1M-token context window (~3–6 MB total request size in pathological cases).
- Caps live as constants in `apps/web/src/lib/ai-gateway/experiments/persist.ts` so they are easy to bump.
- Sentry breadcrumb (no payload) when truncation fires, so we know if it ever happens at non-trivial rates.

**Capture + write path** (capture runs before upstream fetch; R2 writes run inside the same `after()` hook as `accountForMicrodollarUsage`, after the microdollar write):

1. After `applyProviderSpecificLogic` / `provider.transformRequest` has produced the canonical upstream request body, call `buildExperimentPromptCapture(requestBodyParsed.body)` before `upstreamRequest`.
2. `buildExperimentPromptCapture` splits out the single leading `system` message if present, builds the request-body remainder, serializes the two pieces, applies the 4 MB caps, and returns only bounded strings plus `was_truncated`.
3. Store that bounded prompt capture on `MicrodollarUsageContext`; do **not** retain a `structuredClone` of the full uncapped request body through the async `after()` path.
4. In the `after()` hook, for each present bounded half: compute sha256, call `putPromptIfAbsent(content)` which `HEAD`s and only `PUT`s on miss.
5. Insert one row in `model_experiment_request` with the attribution columns and the resulting prompt hashes or sentinels (single statement, single round-trip).

- The R2 puts run in parallel via `Promise.allSettled`. Store each side independently: use the sha256 for successful puts/already-existing objects, `__absent__` for a missing system prompt, and `__failed__` only for the side whose R2 write failed. Log/capture the failure without prompt content. The `model_experiment_request` attribution row always exists when the microdollar usage row exists; prompt storage is best-effort analytics.

**Read path** (out-of-band, never on the request hot path):

- New tRPC procedure `admin.modelExperiments.getPromptByHash(sha: string): Promise<{ content: string } | null>` that reads via `getPromptByHash`. Admin-gated, same gate as the rest of the experiment admin surface. It accepts only 64-character lowercase hex hashes; sentinel values are rendered by the caller without touching R2.
- For partner export / partner replay (Part 2), the same `getPromptByHash` is used to materialize blobs into the export bundle.
- Page-level dedup at read time: collect distinct hashes per result page, batch-fetch, join in memory.

**GDPR and consent.**

- Prompts collected for model experiments are treated as user-authorized experiment data submitted under explicit opt-in to the dedicated preview/experiment model, not as part of the default PII dataset governed by `microdollar_usage_metadata` soft-delete.
- The opt-in copy for each preview model must disclose that prompts may be retained for experiment analysis and partner evaluation, and that users are responsible for not submitting PII, secrets, customer data, or other sensitive content they do not want retained under that experiment policy. v1 must not run a real partner experiment until that model-specific opt-in/disclosure exists.
- Prompts collected under experiment opt-in use a dedicated experiment retention policy and are not governed by the default `microdollar_usage_metadata` soft-delete policy.
- Concretely: `softDeleteUser` does **not** delete `model_experiment_request` rows and does **not** delete the referencing R2 objects. The `on delete cascade` on `usage_id` only fires if the underlying `microdollar_usage` row is hard-deleted (which `softDeleteUser` does not do today). A dedicated experiment-data wipe path removes prompt references by setting prompt hash columns to `__deleted__`, then relying on R2 GC for blob cleanup.
- The spec documents this explicitly as the policy. A test in `apps/web/src/lib/user.test.ts` locks the policy in code: after `softDeleteUser` runs, an experiment-attributed user's `model_experiment_request` rows (and the referenced R2 objects) are still present.

**Wipe semantics.**

- `TRUNCATE model_experiment_request` is independent of `microdollar_usage` and safe to run; this also drops attribution. To wipe only prompts while keeping attribution, run `UPDATE model_experiment_request SET system_prompt_sha256 = '__deleted__', request_body_sha256 = '__deleted__'` (optionally scoped to specific experiments).
- After wiping rows or replacing hashes with sentinels, R2 objects are orphaned. Run a periodic GC sweep (cron / one-off) that lists the bucket and deletes any object whose key does not appear in the distinct set of hash columns filtered to 64-character lowercase hex values.
- Deleting an entire experiment's prompts: `UPDATE model_experiment_request SET system_prompt_sha256 = '__deleted__', request_body_sha256 = '__deleted__' WHERE variant_version_id IN (...experiment's versions...)`, then run the GC sweep. To also drop attribution, `DELETE FROM model_experiment_request WHERE variant_version_id IN (...)` first.
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
- Note on context mutation: current `route.ts` calls `getProvider` before constructing `MicrodollarUsageContext`. `getProvider` must therefore return experiment metadata alongside the provider result, and `route.ts` assigns `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, and the bounded prompt capture onto `usageContext` after it is constructed. The existing code already mutates `usageContext` later for fields such as `ttfb_ms`, `status_code`, and `abuse_request_id`; experiment fields follow that route-level mutation pattern rather than mutating context from inside `getProvider`.

### Phase 3 — Variant Picker + Routing

Add `apps/web/src/lib/ai-gateway/experiments/`:

- `pick-variant.ts`
  - `isPublicIdExperimented(publicId)`: fast membership check through helpers added to `apps/web/src/lib/redis-keys.ts` (`EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` / `modelExperimentRedisKey(publicId)`). The membership value contains every `public_model_id` with `status IN ('active', 'paused')`. Used by `getProvider` (see below) as a fast pre-check before the per-public-id fetch, and by the `kilo-auto` candidate-set construction. On Redis error, the function queries Postgres for that `public_model_id` instead of falling through. If both Redis and Postgres are unavailable, return an explicit `unavailable` result so explicit requests to preview experiment ids receive the gateway's "temporarily unavailable" response instead of silently routing as non-experimented traffic.
  - `getRoutingExperimentForPublicId(publicId)`: returns the routing-relevant experiment with its current status (`active` or `paused`) and resolved variant + version data, `null` when Postgres proves there is no routing-relevant experiment, or `unavailable` when cache/database/config failures prevent a safe routing decision. For each variant, the cached payload contains the current `variant_version_id`, the `upstream` JSONB blob (no key), and the **decrypted** `api_key` merged in alongside as a separate field (in-memory shape: `{ ...upstream, api_key }`). Per-public-id cache at `modelExperimentRedisKey(publicId)`, Redis-cached for 10 minutes. Pre-checks `isPublicIdExperimented` to avoid fetching when no experiment exists. The cache build resolves "current version" per variant via `SELECT DISTINCT ON (variant_id) id, variant_id, upstream, encrypted_api_key, effective_at FROM model_experiment_variant_version WHERE variant_id IN (...) AND effective_at <= now() ORDER BY variant_id, effective_at DESC, id DESC` (Postgres-specific; one query for the experiment, no per-variant round trips), then calls `decryptApiKey(encrypted_api_key, BYOK_ENCRYPTION_KEY)` per row before serialising to Redis. If `BYOK_ENCRYPTION_KEY` is unset for an active/paused experiment, return `unavailable` and log a single warn-level error per process boot.
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
- `index.ts`
  - Public exports for the gateway and tests.

Integration in `getProvider` (`apps/web/src/lib/ai-gateway/providers/get-provider.ts`) and `route.ts`:

- Extend `getProvider`'s return type with optional experiment routing metadata, because `route.ts` constructs `MicrodollarUsageContext` after `getProvider` returns. A new branch is added near the top of `getProvider`, after the BYOK branches and **before** the `kilo-internal/...` branch and the `kiloExclusiveModels` lookup. Pseudocode:
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
        skipBalanceCheck: true,
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
        skipBalanceCheck?: boolean;
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
- Experiment traffic uses `skipBalanceCheck: true` because preview experiment traffic is free/provider-funded for v1. It does **not** skip server-side organization policy checks: `route.ts` still calls `checkOrganizationModelRestrictions` for experimented public ids, but it must not apply provider pinning (`body.provider`) to direct experiment upstreams. `skipKiloExclusiveModelSettings: true` separately prevents registry `internal_id`/provider rewrites from overriding the selected variant.
- `applyProviderSpecificLogic` accepts route metadata that skips only Kilo-exclusive model settings when `skipKiloExclusiveModelSettings` is true. Generic provider-specific request fixes still run, and `provider.transformRequest` still performs the direct experiment rewrite before the upstream fetch.

Routing scope:

- Applies only when the request's resolved public id is in the experimented SET. Under Dedicated mode v1 these are dedicated testing public ids (e.g. `kilo/preview-experiment-foo`) that clients select explicitly.
- `kilo-auto` resolution does not feed experimented public ids: the auto-router's candidate-set construction excludes any public id where `isPublicIdExperimented(publicId)` is true (one-line guard near `applyResolvedAutoModel`). Dedicated testing ids never get silently selected by auto-routing.
- Does not apply to BYOK requests or `kilo-internal/...` traffic (those branches are matched first / by id prefix and never reach the experiment branch).
- Balance checks are skipped for experimented preview ids because v1 traffic is free/provider-funded. Server-side organization allow/deny and data-collection policy checks still run against the public model id; direct experiment routing ignores only the provider-pinning side effect because the upstream is selected by the experiment variant.
- Experimented traffic goes **direct to `upstream.base_url`** — OpenRouter and Vercel are never contacted. No gateway pin needed.

### Phase 4 — Usage, Metrics, and Reporting

Persist experiment attribution everywhere request-level metrics are consumed:

- `MicrodollarUsageContext`: add `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, and `experimentPromptCapture`. The picker also returns `variantId` and `experimentId` for in-memory use (debug logs only), but only `variantVersionId` and `allocationSubject` are persisted to `model_experiment_request`. The `upstream` blob is consumed by `buildDirectProvider` and not stored on the context. `experimentPromptCapture` holds the bounded canonical prompt capture used by the prompt-storage path; it never stores the full uncapped request body.
- **Decoupled experiment write.** The microdollar write remains the billing source of truth, and experiment attribution is written as a separate best-effort analytics row. Small `processUsage.ts` changes are allowed if they keep this flow simpler, such as accepting pre-generated `usageId`/`createdAt` or returning the inserted usage identity. Inside the same `after()` hook scheduled by `accountForMicrodollarUsage`, a new step runs `persistExperimentAttribution` (see `apps/web/src/lib/ai-gateway/experiments/persist.ts`) when `usageContext.modelExperimentVariantVersionId` is set. Failure of the experiment write is Sentry-reported but does not roll back the microdollar write (billing must succeed independently of analytics).
- `persistExperimentAttribution` consumes the bounded `experimentPromptCapture` from `MicrodollarUsageContext`. It performs, in order:
  1. In parallel: `putPromptIfAbsent(system_message_content)` and `putPromptIfAbsent(request_body_remainder)` for the bounded present halves, returning sha256 hex digests.
  2. Insert one row into `model_experiment_request` carrying both the attribution columns and the resulting prompt hashes/sentinels (single statement). On R2 put failure, only the failed side receives `__failed__`; the attribution row still lands.
- PostHog: no change in v1. `processUsage.ts` does not emit a general per-request PostHog event today, and adding one purely for experiment fields is out of scope. Feedback joins (`Feedback Submitted.parentMessageID = client_request_id`) are queried via existing PostHog dashboards out-of-band, linked from the admin UI.
- Analytics Engine: no v1 work. Adding experiment dimensions to `services/o11y/pipelines/api-metrics-schema.json`, `services/o11y/src/api-metrics-routes.ts`, `apps/web/src/lib/ai-gateway/o11y/api-metrics.server.ts`, `services/o11y/src/o11y-analytics.ts`, the o11y tests, and possibly `services/o11y/wrangler.jsonc` (pipeline stream recreation) is deferred until a concrete AE-backed dashboard needs experiment dimensions. v1 admin reports come from Postgres only.
- Reporting view: add `model_experiment_request_stats`, joining `model_experiment_request → model_experiment_variant_version → model_experiment_variant → model_experiment` and `microdollar_usage` / `microdollar_usage_metadata`. The view exposes `upstream->>'internal_id' AS internal_id`, `upstream->>'base_url' AS base_url`, `variant_label`, and `experiment_id` so reports never need to recreate the join chain. **The view explicitly does not select `upstream->>'api_key'`** — keys live only in the version row JSONB and the Redis cache.
- Provider report template: document per-RC request count, error rate, p50/p95 TTFT and total latency, input/output token aggregates, and unique users. Cost per RC is excluded for v1 per the pricing decision. Thumbs-up/down rate is queried via PostHog dashboards out-of-band, linked from the admin UI.

Reports should group by `variant_version_id` for per-RC attribution. `variant_id` (the slot) and `internal_id` (resolved through the version) are both useful secondary groupings; `variant.label` is a mutable display name only.

### Phase 5 — Admin tRPC + UI

Add `apps/web/src/routers/admin/model-experiments-router.ts` with:

- Experiment methods: `list`, `get`, `create`, `update`, `delete` (draft only), `activate`, `pause`, `complete`, `setArchived(id, archived: boolean)`.
- Variant methods: `addVariant` and `removeVariant` are allowed only on `draft` (structural). `updateVariantLabel` is allowed in any non-terminal state. `swapVariantVersion(variantId, { upstream, apiKey })` is allowed in any non-terminal state (`draft`, `active`, `paused`); validates `upstream` against `ExperimentUpstreamSchema` (strict), calls `encryptApiKey(apiKey, BYOK_ENCRYPTION_KEY)`, and inserts a new `model_experiment_variant_version` row with `effective_at = now()`. `rotateApiKey(variantId, apiKey)` is sugar that calls `swapVariantVersion` with the latest version's `upstream` and the new key. Both reject when `BYOK_ENCRYPTION_KEY` is unset (`INTERNAL_SERVER_ERROR`, mirroring `byok-router.ts:202`). No UPDATE on the variant row is needed — "current version" is derived.
- Guardrails: activation validates `weight > 0` per variant, ≥2 variants, every variant has at least one version with `effective_at <= now()`, and (active|paused) uniqueness per `public_model_id`. Weight or structural edits after activation are rejected; create a new experiment instead. Hot-swap and label edits are the only live mutations. `model_experiment_variant_version` rows are insert-only — no UPDATE or DELETE endpoints. `setArchived(id, true)` rejects when status is `active`.
- Admin response shape: `get(id)` and `list()` MUST NOT return `encrypted_api_key` or any plaintext key. Admin queries explicitly select non-key columns (no `SELECT *`). The UI shows a "configured" indicator + the version's `created_at` as a proxy for last-rotated. Reading raw keys is impossible via tRPC by design; the only consumer of `decryptApiKey` for experiment versions is `getRoutingExperimentForPublicId` (gateway side, when populating the per-public-id cache).
- Cache invalidation for every mutation that can affect routing (status transitions, `swapVariantVersion`, `addVariant`/`removeVariant` on draft transitioning to active). Two keys are maintained:
  - Per-publicId cache: `modelExperimentRedisKey(publicId)` — invalidated on any change to the experiment matching that public id.
  - Membership key: `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY` — recomputed (`SELECT public_model_id FROM model_experiment WHERE status IN ('active', 'paused')`) and rewritten on every status transition into or out of (active, paused). Use the existing Redis string helpers with a JSON-encoded array unless this change also adds set-command helpers.
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
- API key never leaks: `getLiveStats`, `list`, `get`, and the reporting view never return `encrypted_api_key` or any plaintext form. Snapshot test on JSON responses; SQL-level test that `model_experiment_request_stats` does not reference the column.
- Encryption round-trip: a key submitted via `swapVariantVersion`/`rotateApiKey` is stored as `EncryptedData` JSONB, is decrypted correctly by the cache loader, and the resulting plaintext is what reaches `buildDirectProvider` as `apiKey` (assert via mock `fetch` capturing the `Authorization` header).
- Rotation: `rotateApiKey` inserts a new version row, the cache (after invalidation) returns the new key, and old request rows still resolve to the prior version (with the old encrypted key intact in the DB).
- Missing `BYOK_ENCRYPTION_KEY`: `swapVariantVersion`/`rotateApiKey` reject; `getRoutingExperimentForPublicId` returns `unavailable` for active/paused experiments and the route returns "temporarily unavailable" instead of falling through.
- Bypass routing: an experimented public id never produces a `fetch` against OpenRouter (`openrouter.ai`) or the Vercel AI gateway, regardless of `shouldRouteToVercel` state.
- Membership key maintenance: activating/pausing/completing an experiment correctly adds/removes its `public_model_id` from `EXPERIMENTED_PUBLIC_IDS_REDIS_KEY`.
- Custom-LLM regression: existing `kilo-internal/...` traffic still routes correctly via the refactored `buildDirectProvider` helper.
- Prompt storage write path: an experimented request produces exactly one row in `model_experiment_request`, with `system_prompt_sha256` and `request_body_sha256` populated as either real 64-character hashes or reserved sentinels. Real hashes point to R2 objects with content matching the original post-`transformRequest` bytes.
- Content-addressing dedup: two distinct requests with the same system prompt produce two `model_experiment_request` rows pointing at the **same** real `system_prompt_sha256`, and the final R2 object content is correct. Do not assert an exact `PUT` count because concurrent `HEAD`/`PUT` calls can race harmlessly.
- Prompt write decoupling: simulating an R2 `PUT` failure does not roll back the `microdollar_usage` write; the `model_experiment_request` row still lands with `__failed__` only for the failed side, successful side hashes are preserved, and Sentry is notified.
- Truncation: a request body exceeding 4 MB on the system or non-system side is truncated deterministically, the resulting hash is stable across runs, and `was_truncated = true` is recorded.
- `getPromptByHash` admin tRPC procedure returns the original content for a known hash and `null` for an unknown hash; sentinel values are rejected or handled before the tRPC call, and non-admin callers are rejected.
- Soft-delete policy: after `softDeleteUser` runs against a user who participated in an experiment, that user's `model_experiment_request` rows are still present (including their prompt hash columns), and the referenced R2 objects are still present. (Locks the consent-based retention policy in code.)

## Caching, Privacy, and Logging

- Prompt-cache behavior needs no change. `applyTrackingIds` salts by provider/user/task, while upstream providers key on `(model, cache_key)`, so different internal checkpoints naturally separate caches.
- `model_experiment`, `model_experiment_variant`, `model_experiment_variant_version`, and `model_experiment_request` hold no direct PII.
- The prompt-hash columns on `model_experiment_request` and the R2 prompt bucket together hold user-authorized experiment data. The opt-in disclosure places responsibility on users not to submit PII, secrets, customer data, or other sensitive content they do not want retained for experiment analysis or partner evaluation. Retention is governed by explicit experiment opt-in and the dedicated experiment retention policy, not the default `microdollar_usage_metadata` soft-delete policy (see Prompt Storage > GDPR and consent). Automatic retention-window enforcement is a follow-up, not v1. The policy is locked in by a test in `apps/web/src/lib/user.test.ts` asserting that `softDeleteUser` does not delete experiment rows or R2 objects.
- `client_request_id` is opaque and per-message. It is joinable to user activity through `model_experiment_request.usage_id`. The `on delete cascade` on `usage_id` only fires for hard deletes of `microdollar_usage`, which `softDeleteUser` does not perform.
- Do not log full request bodies for experimental traffic into `api_request_log`. The dedicated R2 prompt store is the only persistence mechanism for experiment prompt content; `api_request_log` remains allowlist-only and unrelated to experiments.
- Do not put `client_request_id` or experiment fields into Sentry input payloads; keep them to usage/metrics storage.
- `upstream.api_key` MUST never be logged, returned by tRPC reads, included in error messages, included in Sentry breadcrumbs, or persisted outside the encrypted JSONB column and the gateway-side Redis cache. See "API Keys" section.

## API Keys

The partner-issued upstream API key for each variant version is handled with the same primitives as BYOK keys.

- **Encryption helper.** Reuses `encryptApiKey` / `decryptApiKey` from `apps/web/src/lib/ai-gateway/byok/encryption.ts:12,47` (Node `crypto` AES-256-GCM, 12-byte random IV, 256-bit key from `BYOK_ENCRYPTION_KEY` env var via `apps/web/src/lib/config.server.ts:93`). No new encryption module, no new env var.
- **Storage.** Sibling column on `model_experiment_variant_version`: `encrypted_api_key jsonb not null`, typed as `EncryptedData` (`packages/db/src/schema-types.ts:374`). Identical to `byok_api_keys.encrypted_api_key`. Not stored inside the `upstream` JSONB so that "never read the key" can be enforced at the column level (reporting view, admin response shapers, and Drizzle selects can simply omit it).
- **Decryption point: cache-build only.** `getRoutingExperimentForPublicId` decrypts `encrypted_api_key` once when populating the per-public-id Redis cache and stores the resulting plaintext alongside the rest of the resolved upstream blob in the cached payload. The hot path reads decrypted values from Redis; per-request decryption cost is zero. Trade-off: Redis holds plaintext keys for ≤10 minutes (cache TTL); same trust boundary as session tokens already cached there. If `BYOK_ENCRYPTION_KEY` is unset for an active/paused experiment, `getRoutingExperimentForPublicId` returns `unavailable` and logs a single error so the route fails closed with "temporarily unavailable."
- **Hard never-read via admin APIs.** No tRPC endpoint returns the plaintext or ciphertext to the client. The admin UI shows only a "configured" indicator and the version's `created_at` (effectively last-rotated). To rotate, you submit a new key — you cannot retrieve the existing one. This matches BYOK behavior.
- **Rotation = new version insert.** A `rotateApiKey(variantId, newApiKey)` mutation inserts a new `model_experiment_variant_version` row with the same `upstream` blob and a freshly encrypted `encrypted_api_key`, `effective_at = now()`. No special UPDATE path. Version rows are immutable — no exception for keys.
- **Admin gate.** Same gate as gateway-config / custom-llms admin pages. No dedicated role or two-person review for v1.
- **Audit trail.** None beyond `model_experiment_variant_version.created_by` + `created_at`. Adding a dedicated audit log is deferred until compliance asks.
- **Never logged or exported.** Excluded from tRPC responses, the `model_experiment_request_stats` reporting view (column not selected), Sentry breadcrumbs/payloads, upstream-error normalization (strip `Authorization` from any echoed request context — extend `redactSensitiveHeaders` use to the experiment error path), Drizzle query logs (the column is large enough to be omitted from default debug logging anyway, but ensure no `SELECT *` admin queries against this table), and Part 2 partner trace exports (allowlist-only — explicit test).
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

- **No Analytics Engine dimensions in v1.** The o11y pipeline (`services/o11y`) does not get experiment dimensions in v1. Any AE-backed dashboard (Grafana etc.) will not slice by experiment/variant/RC. Admin reporting is Postgres-only via `model_experiment_request_stats`. If/when a real AE consumer appears, a follow-up adds the fields to `api-metrics-schema.json`, `api-metrics-routes.ts`, `api-metrics.server.ts`, `o11y-analytics.ts`, the o11y tests, and (likely) recreates the pipeline stream via `wrangler.jsonc`.

## Risk Areas

- Routing order: variant selection must happen inside `getProvider`, before `route.ts` runs balance and org-model-restriction checks. Experiment traffic skips only the balance check because v1 preview traffic is free/provider-funded; server-side organization policy checks still run before upstream fetch.
- Historical attribution: reports must group by `model_experiment_request.variant_version_id` (immutable FK to the exact RC served) and resolve `upstream` through the version row. Never compute "current version of variant X" as part of a historical report; that's mutable.
- Anonymous allocation stability: `machine` and `ip` cohorts are lower-confidence than `user`; reports must expose/filter by `allocation_subject`. Identifier-less traffic is not routed or recorded; it fails closed as temporarily unavailable.
- Structural edits: weight/add/remove operations are only legal on `draft` experiments. Once activated, structural changes require a brand-new experiment — there is no `paused → draft` transition because data collected under one bucket layout cannot be carried over to a different one. Hot-swap (new RC under existing slot) is not structural and is allowed in any non-terminal state.
- Cache invalidation: admin mutations that affect routing must clear the per-public-id cache via `modelExperimentRedisKey(publicId)`. The cached value contains decrypted `api_key`s, so the cache TTL doubles as a key-rotation lag bound (see "API Keys").
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
- Partner trace export, redaction, HMAC webhooks, partner auth, and warehouse coordination (see [Part 2](./experimental-models-2.md)).
- Replay bundles, SWE-bench/OpenHands adapters, and held-out replay-eval service (see [Part 2](./experimental-models-2.md)).

## Files Touched

Core experiment implementation:

- `packages/db/src/schema.ts`
- `packages/db/src/migrations/<generated>_*.sql`
- `apps/web/src/lib/ai-gateway/experiments/pick-variant.ts` (uses `decryptApiKey` from `apps/web/src/lib/ai-gateway/byok/encryption.ts`; no new module)
- `apps/web/src/lib/ai-gateway/experiments/build-direct-provider.ts`
- `apps/web/src/lib/ai-gateway/experiments/persist.ts` (new — owns `buildExperimentPromptCapture`, `persistExperimentAttribution`, size caps, sha256 hashing, R2 puts, and the single-row insert into `model_experiment_request`)
- `apps/web/src/lib/ai-gateway/experiments/index.ts`
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

- `apps/web/src/lib/user.test.ts` (add test asserting `softDeleteUser` does **not** delete `model_experiment_request` rows or referenced R2 objects)

Admin and routing:

- `apps/web/src/lib/redis-keys.ts`
- `apps/web/src/routers/admin/model-experiments-router.ts` (includes `getPromptByHash` procedure)
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
- Send an experimented request, then in the admin UI navigate to the experiment's request browser, pick a row, and confirm the system + user prompts inflate from R2 via `getPromptByHash`. Verify the dev bucket (`kilo-experiment-prompts-dev`) actually receives the object.
- Send 100 experimented requests with the same system prompt; confirm only one R2 object exists for that system-prompt hash (R2 console object count or `aws s3 ls` against the bucket via the configured endpoint).
- Pause/resume + hot-swap flow continues to populate prompt rows correctly across the transition.
- Run the prompt-orphan GC sweep against the dev bucket after `UPDATE model_experiment_request SET system_prompt_sha256 = '__deleted__', request_body_sha256 = '__deleted__'`; confirm all orphaned R2 objects are deleted and no production data is touched (separate bucket).
