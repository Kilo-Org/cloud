# Experimental Models Part 1 Implementation Plan

This is the implementation plan for the model experiments spec in `.specs/model-experiments.md`. The spec owns durable product behavior and invariants. This document is limited to implementation status, architecture notes, remaining engineering work, touched files, and verification steps.

See also [Part 2: Partner Trace Export and Replay Roadmap](./experimental-models-2.md).

## Status

| Phase | Status | Current State |
|---|---|---|
| Phase 1: Schema and Migration | [done] | Experiment tables exist. `model_experiment_request` is monthly range-partitioned on `created_at`, uses primary key `(usage_id, created_at)`, and stores one full-body prompt hash plus `request_kind`. |
| Phase 2: Gateway Header Capture | [done] | Gateway captures client request id, session id, machine id, and client IP, then threads them into provider selection and usage context. |
| Phase 3: Variant Picker and Routing | [done] | Experimented public ids route through deterministic picking, load routing details from Postgres after Redis membership pre-check, and go directly to the selected partner upstream. |
| Phase 4: Usage, Metrics, and Reporting | [done-core] | Attribution rows and R2 prompt bodies are written after microdollar usage. Admin request log reads rows inline. Live aggregate reporting is deferred. |
| Phase 5: Admin tRPC and UI | [done-core] | Admin CRUD, state transitions, hot-swap, key rotation, UI tab, request log, and prompt-body download exist. Live stats and inline prompt inflation are deferred. |
| Phase 6: Specs and Tests | [done-core] | Spec and AGENTS registration exist. Core picker, routing, admin, prompt persistence, partitioning, and soft-delete policy tests exist. Response client-blinding tests remain with the response-rewrite follow-up. |

## Current Implementation

### Schema

Schema lives in `packages/db/src/schema.ts`. The implementation adds these tables:

- `model_experiment`
- `model_experiment_variant`
- `model_experiment_variant_version`
- `model_experiment_request`

Upstream JSON validation lives in `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts`.

Deferred schema/reporting work:

- Add `model_experiment_request_stats` only when `getLiveStats` or another aggregate report needs a stable query shape.
- Add automatic retention-window enforcement and prompt-orphan R2 garbage collection when retention automation is prioritized.

### Gateway Capture

- `apps/web/src/app/api/openrouter/[...path]/route.ts` extracts `x-kilo-request` into `clientRequestId`.
- `x-kilo-session` is used as a fallback session id when `x-kilocode-taskid` is absent.
- `x-kilocode-machineid` and client IP are threaded into `getProvider`.
- `MicrodollarUsageContext` includes optional experiment fields so existing construction sites do not need broad rewrites.

### Routing

- `membership.ts` performs the Redis membership pre-check with short in-process caching.
- `pick-variant.ts` loads routing-relevant experiments from Postgres and selects the current version for each variant using `SELECT DISTINCT ON (variant_id)`.
- `pickModelExperimentVariant` uses deterministic weighted picking and returns route-visible selection metadata.
- `build-direct-provider.ts` builds the direct custom provider shape used by both experiments and `kilo-internal/...` custom LLM routing.
- `get-provider.ts` returns a discriminated result: `provider`, `not-found`, or `unavailable`.
- `route.ts` handles `not-found` and `unavailable` before dereferencing the provider, then copies experiment metadata into usage context for active selections.
- `apply-provider-specific-logic.ts` supports skipping Kilo-exclusive model rewrites while preserving generic request fixes and direct-provider transforms.
- `auto-model/resolution.ts` does not include experimented preview ids in auto-router candidate sets.

### Prompt Capture and Attribution

- `apps/web/src/lib/r2/experiment-prompts.ts` stores prompt bodies in R2 under sha256 keys and supports reads by hash.
- `apps/web/src/lib/r2/client.ts` reads `R2_EXPERIMENT_PROMPTS_BUCKET_NAME`.
- Current buckets are `kilo-experiment-prompts-dev` and `kilo-experiment-prompts-prod`.
- `buildExperimentPromptCapture` serializes the canonical post-transform request body, records `requestKind`, applies the current implementation cap, and stores bounded capture data on usage context.
- `persistExperimentAttribution` writes prompt content to R2 best-effort and inserts the attribution row with a hash or reserved sentinel.
- `logMicrodollarUsage` and `processTokenData` return `{ usageId, createdAt }` so attribution can key onto the exact usage row.
- `accountForMicrodollarUsage` chains attribution persistence after the microdollar write inside the same `after()` hook.

### Admin

- `apps/web/src/routers/admin/model-experiments-router.ts` implements experiment CRUD, state transitions, variant operations, hot-swap, key rotation, request listing, and routing cache maintenance.
- Admin response shapers explicitly select non-key columns and do not return `encrypted_api_key`.
- `apps/web/src/app/admin/model-experiments/ModelExperimentsContent.tsx` implements list/detail/create/add-variant/hot-swap/rotate-key UI.
- `apps/web/src/app/admin/model-experiments/ModelExperimentRequestsContent.tsx` implements the request browser.
- `apps/web/src/app/admin/api/model-experiments/download/route.ts` downloads captured prompt bodies by usage id after admin auth.
- `/admin/gateway` includes the Model Experiments tab, and `/admin/model-experiments` redirects there.

### Tests

Existing targeted coverage includes:

- Variant picker determinism, subject precedence, weights, missing-subject behavior, paused behavior, and no-experiment behavior.
- Gateway routing to direct partner upstreams instead of OpenRouter or Vercel.
- Usage and attribution persistence.
- Admin activation validation, state transitions, cache maintenance, and edit restrictions.
- API key storage/decryption behavior and non-leakage through admin read paths.
- Prompt storage, content-addressing, R2 failure decoupling, truncation behavior, and request partitioning.
- Soft-delete policy for experiment attribution rows and prompt hashes.

## Remaining Work

### Response Client Blinding

Experiment routing rewrites outbound requests to the selected variant `upstream.internal_id`, but direct partner responses can still echo that id. Implement response rewriting so clients receive the requested public model id in every response shape.

Optional consideration: evaluate whether experiment responses should also be retained for analysis or partner evaluation. This is not required by the current spec and should be designed separately from response rewriting, including explicit policy decisions for sensitive data handling, retention, wipe behavior, storage location, truncation, and admin/provider access.

Implementation target:

- Reuse or generalize existing free-model response rewriters in `apps/web/src/lib/ai-gateway/providers/openrouter/responses.ts` and sibling response helpers.
- Apply rewriting for experiment traffic even though the provider id is `custom`.
- Cover non-streaming JSON responses.
- Cover streaming SSE/event-stream responses for chat-completions, Anthropic messages, and Responses API shapes.

Test target:

- End-to-end experimented chat-completions request: response `model` is the requested public id and never the variant internal id.
- End-to-end experimented messages request: streamed and final model values are rewritten to the requested public id.

### Live Reporting

Only add these when a concrete consumer exists:

- `admin.modelExperiments.getLiveStats(id)`.
- `model_experiment_request_stats` reporting view.
- Analytics Engine dimensions for experiment, variant, or variant version.

### Experiment Model Properties

Add admin support for defining model properties for the experimented public model id, such as context window, supported request/response capabilities, pricing/display metadata, and any other fields needed by clients or routing logic. These properties are not currently configurable through the experiment workflow, so preview ids cannot fully describe model behavior independently of their upstream variants.

Implementation target:

- Decide whether model properties belong on the experiment, the public model id, or a separate model-metadata record referenced by the experiment.
- Ensure clients can discover the experimented model's effective context window and capabilities before sending requests.
- Keep variant upstream configuration separate from client-facing model properties unless a field is intentionally variant-specific.
- Validate that configured properties match the request kinds and provider APIs supported by all active variants.

### Prompt Retention Operations

Only add these when retention automation is prioritized:

- Scheduled prompt-retention enforcement.
- R2 orphan garbage collection after prompt hash wipe operations.
- Operational tooling for experiment-scoped prompt deletion.

### Direct Routing Cleanup

Three direct-upstream paths now use separate flags and policy checks: `custom_llm2`, direct BYOK, and experiments. A follow-up refactor should consolidate direct-routing behavior into a single route-visible abstraction.

Implementation direction:

- Replace scattered flags such as `bypassAccessCheck`, `skipProviderPin`, and `skipKiloExclusiveModelSettings` with a clearer routing mode.
- Centralize checks for request/org policies that cannot be enforced on direct partner endpoints.
- Preserve the distinction between per-org custom LLMs and globally routed experiment public ids.

## Files Touched

Core gateway and persistence:

- `packages/db/src/schema.ts`
- `packages/db/src/migrations/<generated>_*.sql`
- `apps/web/src/app/api/openrouter/[...path]/route.ts`
- `apps/web/src/lib/ai-gateway/experiments/build-direct-provider.ts`
- `apps/web/src/lib/ai-gateway/experiments/membership.ts`
- `apps/web/src/lib/ai-gateway/experiments/persist.ts`
- `apps/web/src/lib/ai-gateway/experiments/pick-variant.ts`
- `apps/web/src/lib/ai-gateway/experiments/upstream-schema.ts`
- `apps/web/src/lib/ai-gateway/llm-proxy-helpers.ts`
- `apps/web/src/lib/ai-gateway/processUsage.ts`
- `apps/web/src/lib/ai-gateway/processUsage.types.ts`
- `apps/web/src/lib/ai-gateway/providers/apply-provider-specific-logic.ts`
- `apps/web/src/lib/ai-gateway/providers/get-provider.ts`

R2 prompt store:

- `apps/web/src/lib/r2/client.ts`
- `apps/web/src/lib/r2/experiment-prompts.ts`

Admin:

- `apps/web/src/app/admin/api/model-experiments/download/route.ts`
- `apps/web/src/app/admin/api/model-experiments/hooks.ts`
- `apps/web/src/app/admin/gateway/page.tsx`
- `apps/web/src/app/admin/model-experiments/ModelExperimentRequestsContent.tsx`
- `apps/web/src/app/admin/model-experiments/ModelExperimentsContent.tsx`
- `apps/web/src/app/admin/model-experiments/page.tsx`
- `apps/web/src/lib/redis-keys.ts`
- `apps/web/src/routers/admin-router.ts`
- `apps/web/src/routers/admin/model-experiments-router.ts`

Specs and tests:

- `.specs/model-experiments.md`
- `AGENTS.md`
- `apps/web/src/lib/user/index.test.ts`
- Additional gateway/admin/prompt tests colocated with their implementation areas.

## Manual Verification Checklist

- Create and activate a two-variant experiment.
- Verify requests create `model_experiment_request` rows linked to `microdollar_usage`.
- Confirm repeated requests for one user keep stable variant assignment.
- Confirm a live variant hot-swap inserts a new variant version and new requests use it.
- Confirm old attribution rows still resolve to the original variant version.
- Confirm `model_experiment_request.created_at` exactly matches the referenced usage row.
- Submit feedback from a client and verify `parentMessageID` joins to `client_request_id`.
- Pause an experiment and confirm requests to the experimented public id return local model-unavailable after cache invalidation or TTL.
- Resume a paused experiment and confirm a returning user stays in the same variant slot.
- Archive a completed experiment and confirm it disappears from default admin lists.
- Attempt to archive an active experiment and confirm the admin call rejects.
- Download a captured request body from the admin request browser and verify the dev R2 bucket contains the referenced object.
- Send two byte-identical transformed requests and confirm both rows reference the same prompt hash.
- After prompt-hash wipe operations, run the future R2 orphan GC against the dev bucket and confirm production data is untouched.
