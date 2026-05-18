# Experimental Models — Part 1: Core A/B Experiment System

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

| Area                   | Decision                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Experiment scope       | One experiment targets one public model id (`public_id`) and swaps the upstream checkpoint (`internal_id`) behind it. Clients keep sending the same public model id.                                                                                                                                                                          |
| Allocation             | N variants with positive integer weights (no sum constraint). Bucketing is deterministic on the first available subject: `kilo_user_id` → `machine_id` → `client_ip`. Truly identifier-less traffic is skipped.                                                                                                                               |
| Anonymous traffic      | Anonymous / free-tier traffic is bucketed when `machine_id` or IP is available. `machine` and `ip` cohorts are less stable than authenticated `user` cohorts, so every request records `allocation_subject` for reporting filters.                                                                                                            |
| Client blinding        | Variant id is not disclosed to the client. No `x-kilo-experiment`, no `x-kilo-variant`, and no payload field. Provider reports receive aggregate variant/checkpoint labels only.                                                                                                                                                              |
| Checkpoint replacement | A provider may replace the upstream config (`internal_id`, `base_url`, `api_key`, transforms) on a live variant without ending the experiment, as long as variant slots and weights are unchanged. Users stay pinned to the same variant slot.                                                                                                |
| Structural edits       | Adding/removing variants or changing weights requires pause → edit → activate. Live structural edits would shift bucket ranges and corrupt longitudinal cohorts.                                                                                                                                                                              |
| Per-request snapshot   | Experimented requests get one row in `model_experiment_request`, keyed by `usage_id`. That row stores the exact checkpoint selected at routing time. Users are pinned to a variant slot, not necessarily to the same checkpoint forever; if variant A moves from `rc1` to `rc2`, old rows remain attributable to `rc1` and new rows to `rc2`. |
| Feedback attribution   | Gateway stores `x-kilo-request` as `model_experiment_request.client_request_id`. PostHog `Feedback Submitted.parentMessageID` joins to that value, and the experiment request row carries the variant/checkpoint snapshot.                                                                                                                    |
| Storage                | Experiment definitions live in Postgres. Gateway hot-path reads use a short Redis cache invalidated by admin mutations.                                                                                                                                                                                                                       |

### Existing Building Blocks

- Deterministic hash bucketing: `apps/web/src/lib/ai-gateway/getRandomNumber.ts`.
- Runtime A/B precedent: `apps/web/src/lib/ai-gateway/providers/vercel/index.ts`, cached in Redis for ~10 minutes.
- Direct-to-upstream routing pattern: the `kilo-internal/...` branch in `getProvider` (`apps/web/src/lib/ai-gateway/providers/index.ts:138-180`) returns a `{ id: 'custom', apiUrl, apiKey, supportedChatApis, transformRequest, bypassAccessCheck: true }` provider built from a `custom_llm2` row. `openRouterRequest` (`providers/index.ts:344-389`) then `fetch`es `${apiUrl}${path}` with `Authorization: Bearer ${apiKey}` — OpenRouter and Vercel are never contacted. Experiments reuse this exact shape, with the upstream config sourced from the variant version instead of `custom_llm2`.
- Public→internal model rewriting: `applyProviderSpecificLogic` in `apps/web/src/lib/ai-gateway/providers/index.ts` (the kilo-exclusive branch around L296–306), called from `apps/web/src/app/api/openrouter/[...path]/route.ts` after provider resolution. It rewrites `body.model` to `internal_id` and pins `body.provider.only` once, pre-flight. Experiments do not use this path — variant selection happens earlier, inside `getProvider`.
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
  │    │    │    ├─ choose allocation subject: user → machine → ip (fallback: control variant)
  │    │    │    ├─ bucket with getRandomNumber(seed, sumOfWeights)
  │    │    │    ├─ select variant by cumulative weight
  │    │    │    └─ return { experimentId, variantId, variantVersionId, upstream, allocationSubject }
  │    │    ├─ if paused: return PAUSED_ERROR sentinel (route.ts emits 4xx)
  │    │    └─ return buildDirectProvider(upstream)  // same shape as kilo-internal/... provider
  │    └─ else: existing branches (BYOK, kilo-internal, kiloExclusiveModels → openrouter|vercel)
  ├─ org / access checks (bypassed for direct provider, same as kilo-internal)
  ├─ applyProviderSpecificLogic(...) — unchanged; experiment branch is no longer here
  ├─ stash variantVersionId + allocationSubject + clientRequestId onto MicrodollarUsageContext
  ├─ applyTrackingIds (unchanged)
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
  is_control                      boolean not null default false
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
  created_at                      timestamp not null

model_experiment_request_prompt
  usage_id                        uuid pk fk → microdollar_usage(id) on delete cascade
  system_prompt_sha256            text nullable  -- R2 object key in experiment-prompts bucket; null if request had no system message
  request_body_sha256             text nullable  -- R2 object key for the canonical post-transformRequest body excluding messages[0] when system
  was_truncated                   boolean not null default false
  created_at                      timestamp not null
```

IKEB NEM RAK

The `upstream` JSONB blob is validated by `ExperimentUpstreamSchema` (a strict subset of `CustomLlmDefinitionSchema` — see `packages/db/src/schema-types.ts:779-798`):

```ts
const ExperimentUpstreamSchema = z.object({
  internal_id: z.string(),                              // model id sent upstream
  base_url: z.string().url(),                           // upstream endpoint
  opencode_settings: z.object({ ai_sdk_provider: z.enum([...]) }).optional(),
  openclaw_settings: z.object({ api_adapter: z.enum([...]) }).optional(),
  extra_headers: z.record(z.string()).optional(),
  extra_body: z.record(z.unknown()).optional(),
  remove_from_body: z.array(z.string()).optional(),
  add_cache_breakpoints: z.boolean().optional(),
  inject_reasoning_into_content: z.boolean().optional(),
}).strict()
```

The `api_key` is **not** part of `ExperimentUpstreamSchema` and **not** stored in the JSONB blob. It lives in the sibling `encrypted_api_key` column (same `EncryptedData` JSONB shape as `byok_api_keys.encrypted_api_key`) and is merged into the in-memory upstream record only at cache-build time. This makes "never select the key" enforceable at the SQL/column level and allows column-level grants if we ever want them.

Fields deliberately **not** included (and why): `organization_ids` (the experimented public id is registered in `kiloExclusiveModels` and gates org access there); `pricing` (per-RC pricing not used in v1, per §352); `display_name` / `context_length` / `max_completion_tokens` (these belong on the public id, identical across variants).

`model_experiment_variant` is the slot identity (label, weight, control flag, allocation share). `model_experiment_variant_version` is the immutable RC instance held by that slot at a point in time. Hot-swapping an RC is a pure INSERT into `model_experiment_variant_version`; the variant row is not modified. The "current version of variant V at time T" is computed as `SELECT ... FROM model_experiment_variant_version WHERE variant_id = V AND effective_at <= T ORDER BY effective_at DESC, id DESC LIMIT 1` (id used as deterministic tiebreaker for ties at the same millisecond). In practice the picker reads this from the Redis-cached experiment definition (computed once when the cache is built per publicId), not on every request. Old version rows are never modified or deleted, so per-request attribution stays exact via the `variant_version_id` FK on `model_experiment_request` with no snapshot columns and no date-comparison joins. `experiment_id` is reachable via `variant_version_id → variant_id → experiment_id`; storing it on the request row would be denormalization, omitted unless query plans show it's needed.

Admin-router invariants:

- Active experiments must have at least two variants, each with `weight > 0`. No sum constraint — bucketing uses `getRandomNumber(seed, sumOfWeights)` and cumulative walk; UI shows per-variant share as `weight / sum(weights)`.
- Active experiments must have every variant with at least one `model_experiment_variant_version` row whose `effective_at <= now()`. Future-dated versions don't count toward "ready to route."
- Only one routing-relevant experiment can exist per `public_model_id` at a time, where "routing-relevant" means status in (`active`, `paused`). Enforced by partial unique index `WHERE status IN ('active', 'paused')`. `completed` and `draft` are unconstrained — you can have a completed historical experiment alongside a draft replacement queued up, or multiple completed historicals.
- Variants in any non-terminal state (`draft`, `active`, `paused`) may change `label` (cosmetic) and may receive a new `model_experiment_variant_version` insert (the hot-swap operation).
- Variants may not change `weight` or experiment structure (add/remove) while the experiment is `active` or `paused`. Structural edits require returning to `draft` (or being made on `draft`).
- `model_experiment_variant_version` rows are immutable once created; no UPDATE on `upstream` or any other version field. New RC = new version row.
- Activation also requires that every variant has `is_control = true` on exactly one variant. Identifier-less requests to an experimented public id route to the control variant (see Phase 3).
- Hot-swap semantics across states: inserting a new version (with `effective_at <= now()`) preserves every user's _bucket_ (the `variant_id` slot is determined by the deterministic seed `model_exp_${experimentId}_${subject}_${value}` and is unaffected) but serves the new RC under that slot. This is true on `draft`, `active`, and `paused` experiments. **Reports MUST group by `variant_version_id` to keep RC-level metrics clean across hot-swaps.** "Same bucket" means "same slot," not "same RC."

Status state machine:

```
draft        ─activate→ active           (validation: ≥2 variants, weight > 0, every variant has ≥1 version with effective_at <= now(), no other (active|paused) per public_id)
active       ─pause→    paused
paused       ─activate→ active           (same validation; users return to same bucket via deterministic seed; if hot-swaps occurred during pause they now serve the new RC under the same slot)
active       ─complete→ completed        (terminal-for-intent: same routing behavior as paused, but signals "we don't intend to resume")
paused       ─complete→ completed
draft        ─delete→   (row removed; only allowed on draft)
[no other transitions; completed is intent-terminal]
```

Routing behavior per status:

- `draft`: experiment is invisible to the gateway; requests to the public id route as if no experiment exists.
- `active`: gateway buckets and rewrites per the experiment.
- `paused` and `completed`: requests to the experimented public id receive an explicit "experiment paused, traffic temporarily unavailable" error response (4xx). They do **not** silently fall through to default routing — that would deliver unexperimented traffic under a public id whose pricing/availability contract was set up for the experiment.

Archive: `is_archived` is an orthogonal boolean. Archiving hides the experiment from default admin lists but doesn't change routing or status. Archiving an `active` experiment is forbidden (DB-level CHECK + admin-router guard); archive any non-active state freely. Unarchive is allowed.

`model_experiment_request` stores experiment attribution only for requests where an experiment was actually applied, with a direct one-to-one link to the usage row.

Indexes for `model_experiment_request`:

- Primary key / unique reference: `usage_id`.
- `(variant_version_id, created_at)` for per-RC reports (the primary checkpoint-level grouping).
- Partial index on `client_request_id` where not null for feedback joins.

Experiment- and variant-level reports go through join: `request → variant_version → variant → experiment`. The served upstream config is read from `model_experiment_variant_version.upstream` JSONB; reports surface `upstream->>'internal_id'` and (where useful) `upstream->>'base_url'`. **Never select `upstream->>'api_key'` in any reporting view, admin query, or response payload.** If query plans show the join hop is hot, add a covering index or denormalize `variant_id` and/or `experiment_id` onto the request row later — defer until measured.

`model_experiment_request.created_at` and `model_experiment_request_prompt.created_at` are both pre-generated in app code at the start of the after-hook (see Phase 4) along with `usage_id`, then copied into all three tables by the writers. This keeps time-window joins exact and avoids the previous "same-CTE" coupling between `processUsage.ts` and the experiment write.

`model_experiment_request_prompt` stores **only hashes**, never prompt content. The bodies live in R2 (see Prompt Storage below), keyed by sha256. Storing only hashes keeps the Postgres row tiny (~80 bytes), keeps PG TOAST out of the picture entirely, and lets the experiment data wipe cleanly without coordinating with the primary datastore.

No backfill is required because pre-experiment traffic has no side-table row.

### Prompt Storage (R2)

Full request prompts (system message + canonical post-`transformRequest` body) are stored in a dedicated R2 bucket using the **content-addressed** pattern from the kilo-cloud reference design: each unique blob is written once under its sha256 hex digest as the object key, and Postgres event rows reference only the hash. This piggybacks on the existing R2 setup in `apps/web` (`apps/web/src/lib/r2/client.ts` already configures the singleton `S3Client` against R2 via `@aws-sdk/client-s3`).

**Bucket layout: one bucket per environment.**

- New env var: `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`.
- Dev value: `kilo-experiment-prompts-dev`.
- Prod value: `kilo-experiment-prompts-prod`.
- The two buckets are fully isolated — no cross-env keys, no cross-env reads. Set up the same way `R2_CLI_SESSIONS_BUCKET_NAME` and `CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME` are configured today.
- New helper module: `apps/web/src/lib/r2/experiment-prompts.ts`. Exports `putPromptIfAbsent(content: string): Promise<string>` (returns the sha256 used as the object key; uses `HeadObjectCommand` to check existence, then `PutObjectCommand` to upload — same pattern as `copyBlobs` in `apps/web/src/lib/r2/cli-sessions.ts:156`) and `getPromptByHash(sha: string): Promise<string | null>` (read via `GetObjectCommand` + `transformToString()`).

**What is stored in R2:**

- One object per unique system message (`messages[0]` when its role is `system`). Object key = sha256 hex of the raw content. Same content from a thousand requests = one R2 object. This is where dedup pays off massively (system prompts are byte-stable across requests within a client version, often 50–200 KB).
- One object per request_body remainder: the canonical post-`transformRequest` body with the system message removed (i.e. `{ ...body, messages: body.messages.filter(m => m.role !== 'system') }` when there is exactly one system message; otherwise the full `messages` array is retained as-is). Object key = sha256 hex. Dedup is incidental for this blob (each request's tail is mostly unique), but storing it in R2 alongside the system blob keeps the storage backend uniform and avoids PG TOAST entirely.

**What is stored in Postgres (`model_experiment_request_prompt`):**

- `usage_id`, `system_prompt_sha256`, `request_body_sha256`, `was_truncated`, `created_at`.
- Either hash column may be null (e.g. a request with no system message yields `system_prompt_sha256 = null`).
- Row is ~80 bytes; the table never holds prompt content.

**Size caps and truncation.**

- `system` content cap: 4 MB. Beyond this the content is truncated to a deterministic prefix before hashing; `was_truncated = true`.
- Non-system body cap: 4 MB serialized JSON. Beyond this the longest individual message is tail-truncated until the total fits, then re-serialized and hashed; `was_truncated = true`.
- 4 MB on each side comfortably exceeds the bytes needed by any current frontier model with a 1M-token context window (~3–6 MB total request size in pathological cases).
- Caps live as constants in `apps/web/src/lib/ai-gateway/experiments/persist.ts` so they are easy to bump.
- Sentry breadcrumb (no payload) when truncation fires, so we know if it ever happens at non-trivial rates.

**Write path** (runs inside the same `after()` hook as `accountForMicrodollarUsage`, after the microdollar write):

1. Take the canonical post-`transformRequest` body (deep-cloned via `structuredClone` immediately after `transformRequest` runs, before any further mutation; passed through `MicrodollarUsageContext` to the after-hook).
2. Split out the single leading `system` message if present.
3. Apply size caps (truncate; flag `was_truncated`).
4. For each non-null half: compute sha256, call `putPromptIfAbsent(content)` which `HEAD`s and only `PUT`s on miss.
5. Insert one row in `model_experiment_request_prompt` with the resulting hashes.

- The R2 puts run in parallel via `Promise.all`. If a put fails, log to Sentry and skip the prompt write (the `model_experiment_request` attribution row still exists; the prompt-side row is best-effort analytics).

**Read path** (out-of-band, never on the request hot path):

- New tRPC procedure `admin.modelExperiments.getPromptByHash(sha: string): Promise<{ content: string } | null>` that reads via `getPromptByHash`. Admin-gated, same gate as the rest of the experiment admin surface.
- For partner export / partner replay (Part 2), the same `getPromptByHash` is used to materialize blobs into the export bundle.
- Page-level dedup at read time: collect distinct hashes per result page, batch-fetch, join in memory. Same pattern as the reference design.

**GDPR and consent.**

- The user explicitly opts in to participate in any given experiment, and that opt-in includes consent to retain prompts for the duration of the experiment plus any agreed retention window. Prompts collected under experiment opt-in are therefore **not** subject to the GDPR soft-delete flow that governs `microdollar_usage_metadata`.
- Concretely: `softDeleteUser` does **not** delete `model_experiment_request_prompt` rows, does **not** delete the referencing R2 objects, and does **not** delete `model_experiment_request` rows. The `on delete cascade` on `usage_id` only fires if the underlying `microdollar_usage` row is hard-deleted (which `softDeleteUser` does not do today).
- The spec documents this explicitly as the policy. A test in `apps/web/src/lib/user.test.ts` locks the policy in code: after `softDeleteUser` runs, an experiment-attributed user's `model_experiment_request` and `model_experiment_request_prompt` rows are still present.
- **Prerequisite (out of scope for Part 1):** the experiment opt-in flow must record a timestamped, per-user, per-experiment consent record (UX + ToS work). v1 must not run a real partner experiment until that consent capture exists. Tracked as a separate v1-prerequisite task; this plan adds a one-line note in the spec under "Prerequisites."

**Wipe semantics.**

- `TRUNCATE model_experiment_request_prompt` is independent of `microdollar_usage` and safe to run.
- After wiping rows, R2 objects are orphaned. Run a periodic GC sweep (cron / one-off) that lists the bucket and deletes any object whose key does not appear in `SELECT system_prompt_sha256 FROM model_experiment_request_prompt UNION SELECT request_body_sha256 FROM model_experiment_request_prompt`.
- Deleting an entire experiment's prompts: `DELETE FROM model_experiment_request_prompt USING model_experiment_request mer WHERE mep.usage_id = mer.usage_id AND mer.variant_version_id IN (...experiment's versions...)`, then run the GC sweep.

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
- Note on context mutation: `MicrodollarUsageContext` is constructed once at `route.ts` ~L431 (before `applyProviderSpecificLogic` runs) but is mutable; the existing code already assigns `ttfb_ms`, `status_code`, and `abuse_request_id` onto it after construction, before `accountForMicrodollarUsage` consumes it at ~L619. Experiment fields (`modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`) follow the same pattern: `applyProviderSpecificLogic` returns the experiment selection record, and the caller assigns those fields onto `usageContext` immediately after.

### Phase 3 — Variant Picker + Routing

Add `apps/web/src/lib/ai-gateway/experiments/`:

- `pick-variant.ts`
  - `isPublicIdExperimented(publicId)`: fast SET-membership check against Redis key `ai-gateway:experimented-public-ids`, TTL 1 hour. The SET contains every `public_model_id` with `status IN ('active', 'paused')`. Used by `getProvider` (see below) as a fast pre-check before the per-public-id fetch, and by the `kilo-auto` candidate-set construction. On Redis error, the function falls through to "not experimented" so the request path never deadlocks.
  - `getRoutingExperimentForPublicId(publicId)`: returns the routing-relevant experiment with its current status (`active` or `paused`) and resolved variant + version data, or `null`. For each variant, the cached payload contains the current `variant_version_id`, the `upstream` JSONB blob (no key), and the **decrypted** `api_key` merged in alongside as a separate field (in-memory shape: `{ ...upstream, api_key }`). Per-public-id cache at `ai-gateway:model-experiment:<publicId>`, Redis-cached for 10 minutes. Pre-checks `isPublicIdExperimented` to avoid fetching when no experiment exists. The cache build resolves "current version" per variant via `SELECT DISTINCT ON (variant_id) id, variant_id, upstream, encrypted_api_key, effective_at FROM model_experiment_variant_version WHERE variant_id IN (...) AND effective_at <= now() ORDER BY variant_id, effective_at DESC, id DESC` (Postgres-specific; one query for the experiment, no per-variant round trips), then calls `decryptApiKey(encrypted_api_key, BYOK_ENCRYPTION_KEY)` per row before serialising to Redis. If `BYOK_ENCRYPTION_KEY` is unset, returns `null` (request falls through to "not experimented") and logs a single warn-level error per process boot.
  - `pickModelExperimentVariant({ publicModelId, userId, machineId, clientIp })`: calls `getRoutingExperimentForPublicId`. Behavior depends on returned experiment status:
    - `active`: pick a variant and return `{ status: 'active', experimentId, variantId, variantVersionId, upstream, allocationSubject }`. If no allocation subject is available (no userId/machineId/clientIp), route to the experiment's `is_control` variant and set `allocationSubject = 'control'`.
    - `paused`: returns `{ status: 'paused' }` so the caller can short-circuit with the 4xx "experiment paused" error response (see Phase 1 routing behavior).
    - `null` (no routing-relevant experiment): returns `null`.

  Only `variantVersionId` and `allocationSubject` are persisted on the request row; `upstream` is used by `buildDirectProvider` and not snapshotted (the immutable version row is the snapshot).
  - Allocation subject precedence: `userId`, then `machineId`, then `clientIp`; fall back to control variant when none exist.
  - `userId` MUST be the authenticated `kilocode_users.id` only. Synthetic anonymous identifiers (e.g., `anon:<ip>`) are never passed as `userId` — anonymous traffic falls through to `machineId`, then `clientIp`. Under Dedicated mode v1, experimented public ids are auth-gated, so the vast majority of allocations will use `userId`.
  - Seed format: `model_exp_${experimentId}_${allocationSubject}_${subjectValue}`.
  - Variant selection: `getRandomNumber(seed, sumOfWeights)`, then cumulative weights walked in `ORDER BY model_experiment_variant.id ASC`. Ordering by the immutable `id` (uuid PK), not by `label`, so live label edits never rebucket users. Reports group by `variant_version_id` and don't depend on slot order.

- `build-direct-provider.ts`
  - `buildDirectProvider(upstream)`: returns the same `Provider` shape that `getProvider`'s `kilo-internal/...` branch returns today (`apps/web/src/lib/ai-gateway/providers/index.ts:138-180`): `{ id: 'custom', apiUrl: upstream.base_url, apiKey: upstream.api_key, supportedChatApis: inferSupportedChatApis(upstream.opencode_settings?.ai_sdk_provider, upstream.openclaw_settings?.api_adapter), transformRequest, bypassAccessCheck: true }`. The existing `kilo-internal` branch is refactored to call this same builder (passing the relevant fields from the `custom_llm2` row) so both code paths share one implementation.
- `index.ts`
  - Public exports for the gateway and tests.

Integration in `getProvider` (`apps/web/src/lib/ai-gateway/providers/index.ts`):

- A new branch is added near the top of `getProvider`, after the BYOK branches and **before** the `kilo-internal/...` branch and the `kiloExclusiveModels` lookup. Pseudocode:
  ```ts
  if (await isPublicIdExperimented(requestedModel)) {
    const selection = await pickModelExperimentVariant({
      publicModelId: requestedModel,
      userId,
      machineId,
      clientIp,
    });
    if (selection?.status === 'paused') {
      return EXPERIMENT_PAUSED_PROVIDER_SENTINEL; // route.ts maps to 4xx
    }
    if (selection?.status === 'active') {
      // record selection on usageContext for later persistence
      usageContext.modelExperimentVariantVersionId = selection.variantVersionId;
      usageContext.modelExperimentAllocationSubject = selection.allocationSubject;
      // capture canonical post-transformRequest body for prompt storage; structuredClone defended against
      // later in-place mutation in the request pipeline. Stored on the context so the after-hook can persist.
      usageContext.experimentRequestBody = structuredClone(body);
      return {
        provider: buildDirectProvider(selection.upstream),
        userByok: null,
        bypassAccessCheck: true,
      };
    }
    // selection === null is unreachable for an experimented id under v1 (control fallback always returns active)
  }
  ```
- Picking inside `getProvider` is required because `bypassAccessCheck` and the upstream `apiUrl/apiKey` must be set before `route.ts:462` runs balance and `checkOrganizationModelRestrictions` checks. This is the same layer where `kilo-internal/...` already integrates.
- `applyProviderSpecificLogic` is **not** modified for experiments. Its existing kilo-exclusive branch is bypassed because the experiment branch returns a `{ id: 'custom' }` provider, which the family-specific logic in `applyProviderSpecificLogic` already no-ops on (same as current `kilo-internal/...` traffic).

Routing scope:

- Applies only when the request's resolved public id is in the experimented SET. Under Dedicated mode v1 these are dedicated testing public ids (e.g. `kilo/preview-experiment-foo`) that clients select explicitly.
- `kilo-auto` resolution does not feed experimented public ids: the auto-router's candidate-set construction excludes any public id where `isPublicIdExperimented(publicId)` is true (one-line guard near `applyResolvedAutoModel`). Dedicated testing ids never get silently selected by auto-routing.
- Does not apply to BYOK requests or `kilo-internal/...` traffic (those branches are matched first / by id prefix and never reach the experiment branch).
- Org allow/deny checks against the public model id are bypassed via `bypassAccessCheck: true`, matching `kilo-internal/...` behavior. The experimented public id's `kiloExclusiveModels` registry entry still gates client-side discovery.
- Experimented traffic goes **direct to `upstream.base_url`** — OpenRouter and Vercel are never contacted. No gateway pin needed.

### Phase 4 — Usage, Metrics, and Reporting

Persist experiment attribution everywhere request-level metrics are consumed:

- `MicrodollarUsageContext`: add `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, and `experimentRequestBody`. The picker also returns `variantId` and `experimentId` for in-memory use (debug logs only), but only `variantVersionId` and `allocationSubject` are persisted to `model_experiment_request`. The `upstream` blob is consumed by `buildDirectProvider` and not stored on the context. `experimentRequestBody` holds the structured-cloned canonical body used by the prompt-storage path; never re-read by anything else.
- **Decoupled experiment write.** `processUsage.ts` is **not modified** by this feature. The microdollar write retains its existing single-CTE shape. Inside the same `after()` hook scheduled by `accountForMicrodollarUsage`, a new step runs `persistExperimentAttribution` (see `apps/web/src/lib/ai-gateway/experiments/persist.ts`) when `usageContext.modelExperimentVariantVersionId` is set. The hook pre-generates `usageId` (`randomUUID()`) and `createdAt` once at the start and passes them into both the microdollar write and the experiment write — no read-back, no timestamp drift. Failure of the experiment write is Sentry-reported but does not roll back the microdollar write (billing must succeed independently of analytics).
- `persistExperimentAttribution` performs, in order:
  1. Split the canonical body into `system_message_content` (single leading `system` message if present) and `request_body_remainder` (everything else, serialized).
  2. Apply size caps (4 MB each); flag `was_truncated` if either side overflowed.
  3. In parallel: `putPromptIfAbsent(system_message_content)` and `putPromptIfAbsent(request_body_remainder)`, returning sha256 hex digests.
  4. Insert one row into `model_experiment_request` (attribution) and one row into `model_experiment_request_prompt` (hashes only) — single statement, both rows reference the same `usage_id`.
- PostHog: no change in v1. `processUsage.ts` does not emit a general per-request PostHog event today, and adding one purely for experiment fields is out of scope. Feedback joins (`Feedback Submitted.parentMessageID = client_request_id`) are queried via existing PostHog dashboards out-of-band, linked from the admin UI.
- Analytics Engine: no v1 work. Adding experiment dimensions to `services/o11y/pipelines/api-metrics-schema.json`, `services/o11y/src/api-metrics-routes.ts`, `apps/web/src/lib/ai-gateway/o11y/api-metrics.server.ts`, `services/o11y/src/o11y-analytics.ts`, the o11y tests, and possibly `services/o11y/wrangler.jsonc` (pipeline stream recreation) is real work for a write-only future hypothetical — defer until a concrete AE-backed dashboard needs experiment dimensions. v1 admin reports come from Postgres only (see Q15 decision).
- Reporting view: add `model_experiment_request_stats`, joining `model_experiment_request → model_experiment_variant_version → model_experiment_variant → model_experiment` and `microdollar_usage` / `microdollar_usage_metadata`. The view exposes `upstream->>'internal_id' AS internal_id`, `upstream->>'base_url' AS base_url`, `variant_label`, and `experiment_id` so reports never need to recreate the join chain. **The view explicitly does not select `upstream->>'api_key'`** — keys live only in the version row JSONB and the Redis cache.
- Provider report template: document per-RC request count, error rate, p50/p95 TTFT and total latency, input/output token aggregates, and unique users. Cost per RC is excluded for v1 per the pricing decision. Thumbs-up/down rate is queried via PostHog dashboards out-of-band, linked from the admin UI.

Reports should group by `variant_version_id` for per-RC attribution. `variant_id` (the slot) and `internal_id` (resolved through the version) are both useful secondary groupings; `variant.label` is a mutable display name only.

### Phase 5 — Admin tRPC + UI

Add `apps/web/src/routers/admin/model-experiments-router.ts` with:

- Experiment methods: `list`, `get`, `create`, `update`, `delete` (draft only), `activate`, `pause`, `complete`, `setArchived(id, archived: boolean)`.
- Variant methods: `addVariant` and `removeVariant` are allowed only on `draft` (structural). `updateVariantLabel` and `setControl(variantId)` are allowed in any non-terminal state. `swapVariantVersion(variantId, { upstream, apiKey })` is allowed in any non-terminal state (`draft`, `active`, `paused`); validates `upstream` against `ExperimentUpstreamSchema` (strict), calls `encryptApiKey(apiKey, BYOK_ENCRYPTION_KEY)`, and inserts a new `model_experiment_variant_version` row with `effective_at = now()`. `rotateApiKey(variantId, apiKey)` is sugar that calls `swapVariantVersion` with the latest version's `upstream` and the new key. Both reject when `BYOK_ENCRYPTION_KEY` is unset (`INTERNAL_SERVER_ERROR`, mirroring `byok-router.ts:202`). No UPDATE on the variant row is needed — "current version" is derived.
- Guardrails: activation validates `weight > 0` per variant, ≥2 variants, exactly one variant with `is_control = true`, every variant has at least one version with `effective_at <= now()`, and (active|paused) uniqueness per `public_model_id`. Weight or structural edits on `active`/`paused` are rejected (return to `draft` to make them — and note: there is no `paused → draft` transition in the state machine, so this effectively means structural changes are forbidden once an experiment has been activated; create a new experiment instead). Hot-swap and label edits are the only live mutations. `model_experiment_variant_version` rows are insert-only — no UPDATE or DELETE endpoints. `setArchived(id, true)` rejects when status is `active`.
- Admin response shape: `get(id)` and `list()` MUST NOT return `encrypted_api_key` or any plaintext key. Admin queries explicitly select non-key columns (no `SELECT *`). The UI shows a "configured" indicator + the version's `created_at` as a proxy for last-rotated. Reading raw keys is impossible via tRPC by design; the only consumer of `decryptApiKey` for experiment versions is `getRoutingExperimentForPublicId` (gateway side, when populating the per-public-id cache).
- Cache invalidation for every mutation that can affect routing (status transitions, `swapVariantVersion`, `addVariant`/`removeVariant` on draft transitioning to active). Two keys are maintained:
  - Per-publicId cache: `ai-gateway:model-experiment:<publicId>` — invalidated on any change to the experiment matching that public id.
  - Membership SET: `ai-gateway:experimented-public-ids` — recomputed (`SELECT public_model_id FROM model_experiment WHERE status IN ('active', 'paused')`) and re-SET on every status transition into or out of (active, paused). Single Redis SET write.
- Paused/completed experiments: gateway returns an explicit 4xx "experiment paused" error for requests to the experimented public id. The error mapping/wording lives in `pick-variant.ts` so the gateway can short-circuit before upstream resolution.
- `getLiveStats(id)`: aggregate recent requests/errors/p50-p95 latency grouped by `variant_version_id`, with `variant.label` and `upstream->>'internal_id'` resolved for display. Token aggregates per RC (input/output) included; `cost_mUsd` excluded for v1 per the pricing decision.
- `getPromptByHash(sha: string): Promise<{ content: string } | null>`: admin-gated tRPC procedure that reads from R2 via `getPromptByHash` (`apps/web/src/lib/r2/experiment-prompts.ts`). Returns `null` if the object doesn't exist. Used by the admin UI to inflate hashes from `model_experiment_request_prompt` rows on demand. Page-level dedup at the call site: collect distinct hashes, batch-fetch, join in memory.

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
- Null return when no active experiment exists; control fallback when no allocation subject exists on an active experiment.
- End-to-end gateway integration for an experimented public id: assert the upstream `fetch` URL starts with the variant's `upstream.base_url` (NOT OpenRouter or Vercel), `Authorization` header carries `Bearer ${upstream.api_key}`, and `body.model` equals `upstream.internal_id`.
- Usage persistence creates a `model_experiment_request` row with `usage_id`, `variant_version_id`, `allocation_subject`, and `client_request_id`.
- Hot-swap test: `swapVariantVersion` inserts a new `model_experiment_variant_version` row with a different `upstream` (different `internal_id` and/or `base_url`), the picker (after cache invalidation) resolves to the new version, and old `model_experiment_request` rows still resolve through their old `variant_version_id` to the original `upstream`.
- Two-variant routing: distinct seeds bucket to distinct variants, each request lands on the corresponding variant's `upstream.base_url`.
- Tiebreaker test: two `swapVariantVersion` calls landing at the same millisecond produce two version rows; "current" is determined by `(effective_at desc, id desc)` deterministically.
- `model_experiment_request.created_at` exactly matches the referenced `microdollar_usage.created_at`.
- Admin activation validation, active-experiment uniqueness, cache invalidation, and live-edit restrictions.
- State machine: every allowed transition succeeds, every disallowed transition returns a clear error. `setArchived(activeId, true)` rejects.
- Paused (and completed) experiment requests to the experimented public id return the 4xx "experiment paused" error and do not reach upstream.
- Anonymous request with machine id is bucketed; identifier-less request routes to control variant; BYOK request to a non-experimented id is unaffected.
- API key never leaks: `getLiveStats`, `list`, `get`, and the reporting view never return `encrypted_api_key` or any plaintext form. Snapshot test on JSON responses; SQL-level test that `model_experiment_request_stats` does not reference the column.
- Encryption round-trip: a key submitted via `swapVariantVersion`/`rotateApiKey` is stored as `EncryptedData` JSONB, is decrypted correctly by the cache loader, and the resulting plaintext is what reaches `buildDirectProvider` as `apiKey` (assert via mock `fetch` capturing the `Authorization` header).
- Rotation: `rotateApiKey` inserts a new version row, the cache (after invalidation) returns the new key, and old request rows still resolve to the prior version (with the old encrypted key intact in the DB).
- Missing `BYOK_ENCRYPTION_KEY`: `swapVariantVersion`/`rotateApiKey` reject; `getRoutingExperimentForPublicId` returns null and the request falls through.
- Bypass routing: an experimented public id never produces a `fetch` against OpenRouter (`openrouter.ai`) or the Vercel AI gateway, regardless of `shouldRouteToVercel` state.
- Membership SET maintenance: activating/pausing/completing an experiment correctly adds/removes its `public_model_id` from `ai-gateway:experimented-public-ids`.
- Custom-LLM regression: existing `kilo-internal/...` traffic still routes correctly via the refactored `buildDirectProvider` helper.
- Prompt storage write path: an experimented request produces exactly one row in `model_experiment_request_prompt`, with `system_prompt_sha256` and `request_body_sha256` populated when the corresponding content is non-null, and the referenced R2 objects exist with content matching the original (post-`transformRequest`) bytes.
- Content-addressing dedup: two distinct requests with the same system prompt produce two `model_experiment_request_prompt` rows pointing at the **same** `system_prompt_sha256`, and only one R2 `PUT` was issued (assert via mocked R2 client capturing call counts).
- Prompt write decoupling: simulating an R2 `PUT` failure does not roll back the `microdollar_usage` write; `model_experiment_request` row may exist without a corresponding `model_experiment_request_prompt` row (best-effort analytics), and Sentry is notified.
- Truncation: a request body exceeding 4 MB on the system or non-system side is truncated deterministically, the resulting hash is stable across runs, and `was_truncated = true` is recorded.
- `getPromptByHash` admin tRPC procedure returns the original content for a known hash and `null` for an unknown hash; non-admin callers are rejected.
- Soft-delete policy: after `softDeleteUser` runs against a user who participated in an experiment, that user's `model_experiment_request` and `model_experiment_request_prompt` rows are still present, and the referenced R2 objects are still present. (Locks the consent-based retention policy in code.)

## Caching, Privacy, and Logging

- Prompt-cache behavior needs no change. `applyTrackingIds` salts by provider/user/task, while upstream providers key on `(model, cache_key)`, so different internal checkpoints naturally separate caches.
- `model_experiment`, `model_experiment_variant`, `model_experiment_variant_version`, and `model_experiment_request` hold no direct PII.
- `model_experiment_request_prompt` and the R2 prompt bucket **do** hold dense PII (full system + user prompts: code, file paths, project context, sometimes secrets pasted by users). Retention is governed by experiment opt-in consent, not GDPR soft-delete (see Prompt Storage > GDPR and consent). The policy is locked in by a test in `apps/web/src/lib/user.test.ts` asserting that `softDeleteUser` does not delete experiment prompt rows or R2 objects.
- `client_request_id` is opaque and per-message. It is joinable to user activity through `model_experiment_request.usage_id`. The `on delete cascade` on `usage_id` only fires for hard deletes of `microdollar_usage`, which `softDeleteUser` does not perform.
- Do not log full request bodies for experimental traffic into `api_request_log`. The dedicated R2 prompt store is the only persistence mechanism for experiment prompt content; `api_request_log` remains allowlist-only and unrelated to experiments.
- Do not put `client_request_id` or experiment fields into Sentry input payloads; keep them to usage/metrics storage.
- `upstream.api_key` MUST never be logged, returned by tRPC reads, included in error messages, included in Sentry breadcrumbs, or persisted outside the encrypted JSONB column and the gateway-side Redis cache. See "API Keys" section.

## API Keys

The partner-issued upstream API key for each variant version is handled with the same primitives as BYOK keys.

- **Encryption helper.** Reuses `encryptApiKey` / `decryptApiKey` from `apps/web/src/lib/ai-gateway/byok/encryption.ts:12,47` (Node `crypto` AES-256-GCM, 12-byte random IV, 256-bit key from `BYOK_ENCRYPTION_KEY` env var via `apps/web/src/lib/config.server.ts:93`). No new encryption module, no new env var.
- **Storage.** Sibling column on `model_experiment_variant_version`: `encrypted_api_key jsonb not null`, typed as `EncryptedData` (`packages/db/src/schema-types.ts:374`). Identical to `byok_api_keys.encrypted_api_key`. Not stored inside the `upstream` JSONB so that "never read the key" can be enforced at the column level (reporting view, admin response shapers, and Drizzle selects can simply omit it).
- **Decryption point: cache-build only.** `getRoutingExperimentForPublicId` decrypts `encrypted_api_key` once when populating the per-public-id Redis cache and stores the resulting plaintext alongside the rest of the resolved upstream blob in the cached payload. The hot path reads decrypted values from Redis; per-request decryption cost is zero. Trade-off: Redis holds plaintext keys for ≤10 minutes (cache TTL); same trust boundary as session tokens already cached there. If `BYOK_ENCRYPTION_KEY` is unset, `getRoutingExperimentForPublicId` returns `null` (request falls through to "not experimented") and logs a single error — matches the BYOK router's `INTERNAL_SERVER_ERROR` posture.
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
- **Error-rate undercount (accepted v1 limitation).** `model_experiment_request` is written in the same CTE as `microdollar_usage`. Today `microdollar_usage` is _not_ written for several failure modes, so those failures will be **invisible in experiment reports**:
  - `fetch` throws (DNS, connection reset) — error bubbles out before `after()`.
  - 10-minute upstream timeouts and client-cancelled requests — same path.
  - Upstream 402 remapped to "temporarily unavailable" (`route.ts` ~L568–581 returns before usage accounting).
  - Upstream 5xx with null body or non-streaming with non-JSON body.
  - Streaming 5xx with any body, and 4xx with parseable body, _do_ produce a row with `has_error=true` and zero tokens.

  v1 accepts this and documents it: experiment error-rate reports systematically undercount the worst failure modes (timeouts, fetch errors, 402, null-body 5xx). For early-development checkpoints, supplement experiment reports with upstream alerting and Sentry on the relevant `inference_provider`. A future iteration may move `model_experiment_request` to a two-phase write (insert eagerly after variant selection, update with `usage_id` later) to capture all failures, or fix `microdollar_usage` to always write on error; both are out of scope here.

- **No Analytics Engine dimensions in v1.** The o11y pipeline (`services/o11y`) does not get experiment dimensions in v1. Any AE-backed dashboard (Grafana etc.) will not slice by experiment/variant/RC. Admin reporting is Postgres-only via `model_experiment_request_stats`. If/when a real AE consumer appears, a follow-up adds the fields to `api-metrics-schema.json`, `api-metrics-routes.ts`, `api-metrics.server.ts`, `o11y-analytics.ts`, the o11y tests, and (likely) recreates the pipeline stream via `wrangler.jsonc`.

## Risk Areas

- Routing order: variant selection must happen inside `getProvider`, before `route.ts` runs balance and org-model-restriction checks (which the experiment branch's `bypassAccessCheck: true` skips, matching `kilo-internal/...` behavior).
- Historical attribution: reports must group by `model_experiment_request.variant_version_id` (immutable FK to the exact RC served) and resolve `upstream` through the version row. Never compute "current version of variant X" as part of a historical report; that's mutable.
- Anonymous allocation stability: `machine` and `ip` cohorts are lower-confidence than `user`; reports must expose/filter by `allocation_subject`. Identifier-less traffic is recorded as `allocation_subject = 'control'` and should be filterable separately.
- Structural edits: weight/add/remove operations are only legal on `draft` experiments. Once activated, structural changes require a brand-new experiment — there is no `paused → draft` transition because data collected under one bucket layout cannot be carried over to a different one. Hot-swap (new RC under existing slot) is not structural and is allowed in any non-terminal state.
- Cache invalidation: admin mutations that affect routing must clear the per-public-id Redis key. The cached value contains decrypted `api_key`s, so the cache TTL doubles as a key-rotation lag bound (see "API Keys").
- API key handling: see dedicated section.
- Provider blinding: provider-facing exports must not include `kilo_user_id` or user-identifying fields.
- R2 prompt-store credential exposure: the same `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` already used by `apps/web/src/lib/r2/client.ts` is reused. Adding an experiment-prompts bucket extends the blast radius of those credentials. Acceptable for v1 because the same trust boundary already covers cli-sessions and cloud-agent-attachments. If/when scoped per-bucket credentials become available cheaply, narrow them.
- Prerequisite (before first real partner experiment): UX + ToS work to capture timestamped per-user, per-experiment consent. Out of scope for Part 1; flagged in spec under "Prerequisites."

> Partner-specific risks (cross-model session contamination, capture fidelity) are covered in [Part 2](./experimental-models-2.md).

## v1 Exclusions

- Per-variant pricing. Variants under one `public_id` share current public-id pricing.
- BYOK traffic.
- Custom LLM traffic (`kilo-internal/...`).
- (No identifier-less traffic exclusion — under v1 such requests route to the experiment's control variant; reports filter on `allocation_subject = 'control'` if the cohort needs to be excluded.)
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
- `apps/web/src/lib/ai-gateway/experiments/persist.ts` (new — owns `persistExperimentAttribution`, size caps, sha256 hashing, R2 puts, and the two-row insert)
- `apps/web/src/lib/ai-gateway/experiments/index.ts`
- `apps/web/src/app/api/openrouter/[...path]/route.ts`
- `apps/web/src/lib/ai-gateway/providers/index.ts` (refactor `kilo-internal/...` branch to share `buildDirectProvider`; add experiment branch; capture `structuredClone(body)` onto `usageContext.experimentRequestBody`)
- `apps/web/src/lib/ai-gateway/llm-proxy-helpers.ts` (extend the existing `after()` hook around `accountForMicrodollarUsage` to also call `persistExperimentAttribution` after the microdollar write completes; pre-generate `usageId` + `createdAt`)
- `apps/web/src/lib/ai-gateway/processUsage.types.ts` (add `modelExperimentVariantVersionId`, `modelExperimentAllocationSubject`, `clientRequestId`, `experimentRequestBody` fields to `MicrodollarUsageContext`)
- **`processUsage.ts` is intentionally not modified** — the experiment write is fully decoupled.

R2 prompt store:

- `apps/web/src/lib/r2/experiment-prompts.ts` (new — `putPromptIfAbsent`, `getPromptByHash`, sha256 helper)
- `apps/web/src/lib/r2/client.ts` (add `r2ExperimentPromptsBucketName` export reading from `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`)
- Env config: add `R2_EXPERIMENT_PROMPTS_BUCKET_NAME` to local `.env.local`, Vercel project envs (preview + production), and the dev env-sync manifest. Two buckets to provision in Cloudflare R2: `kilo-experiment-prompts-dev` and `kilo-experiment-prompts-prod`.

GDPR test:

- `apps/web/src/lib/user.test.ts` (add test asserting `softDeleteUser` does **not** delete `model_experiment_request_prompt` rows or referenced R2 objects)

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
- Pause an experiment and confirm requests to the experimented public id return the "experiment paused" error after cache invalidation/TTL.
- Resume a paused experiment and confirm a returning user lands in the same `variant_id` bucket as before the pause.
- Hot-swap during pause: pause, run `swapVariantVersion` (which inserts a new version row with `effective_at = now()`), resume, send a request from a user who was previously bucketed; confirm the bucket (variant_id) is unchanged but the served `variant_version_id`/`internal_id` resolves to the newly inserted version.
- Archive a `completed` experiment; confirm it disappears from default admin lists. Attempt to archive an `active` experiment; confirm the admin call rejects.
- Send an experimented request, then in the admin UI navigate to the experiment's request browser, pick a row, and confirm the system + user prompts inflate from R2 via `getPromptByHash`. Verify the dev bucket (`kilo-experiment-prompts-dev`) actually receives the object.
- Send 100 experimented requests with the same system prompt; confirm only one R2 object exists for that system-prompt hash (R2 console object count or `aws s3 ls` against the bucket via the configured endpoint).
- Pause/resume + hot-swap flow continues to populate prompt rows correctly across the transition.
- Run the prompt-orphan GC sweep against the dev bucket after `TRUNCATE model_experiment_request_prompt`; confirm all objects are deleted and no production data is touched (separate bucket).
