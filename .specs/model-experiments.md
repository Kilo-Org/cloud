# Model Experiments

## Role of This Document

This spec defines the business rules and invariants for model experiments. It is the source of truth for what future implementation, refactor, admin, reporting, and retention changes must preserve. It deliberately avoids prescribing internal handler names or UI layout details except where those choices enforce a business rule.

## Scope

Model experiments exist only to A/B test preview or otherwise experimental model checkpoints in partnership with model providers. They are not a general-purpose traffic-splitting or rollout mechanism for production models.

An experimented `public_model_id` MUST be a dedicated preview or experiment id that users explicitly select. Production model ids MUST NOT be silently bucketed. Experimented ids MUST NOT be added to `kilo-auto` candidate sets, presets, or other automatic selection paths unless the spec is explicitly changed to allow that behavior.

BYOK requests and `kilo-internal/...` traffic are outside the model-experiment routing path. Experiment traffic routes directly to the selected partner upstream; it MUST NOT depend on OpenRouter or Vercel to perform variant selection.

## Routing and Allocation

Only experiments in routing states participate in gateway membership checks. At most one routing-relevant experiment MAY exist per `public_model_id`, where routing-relevant means `active` or `paused`.

Variant allocation MUST be deterministic for a given experiment, allocation subject, and subject value. Allocation subject precedence is:

1. Authenticated Kilo user id.
2. Machine id.
3. Client IP address.

Synthetic anonymous identifiers MUST NOT be passed as user ids. If no allocation subject is available, the gateway MUST fail closed with temporarily unavailable behavior rather than assigning a fallback bucket.

Variant weights MUST be positive integers. There is no required sum. The picker MUST bucket over the sum of weights and walk variants in immutable id order, not label order, so label edits do not rebucket users.

Clients MUST remain blinded to experiment assignment. The gateway MUST NOT send experiment ids, variant ids, variant labels, or bucket headers/fields to clients. Provider-facing reports MAY include aggregate variant or checkpoint labels but MUST NOT disclose per-user bucket assignments to clients.

## Status State Machine

Valid experiment statuses are `draft`, `active`, `paused`, and `completed`.

Allowed transitions are:

- `draft` -> `active`.
- `active` -> `paused`.
- `paused` -> `active`.
- `active` -> `completed`.
- `paused` -> `completed`.
- `draft` -> deleted row.

No other transition is valid. `completed` is terminal and historical. It MUST NOT be used as a temporary traffic-blocking state; use `paused` until the preview public id is removed or a replacement experiment is active.

Routing behavior by status:

- `draft`: invisible to the gateway.
- `active`: gateway buckets and routes through the experiment.
- `paused`: gateway returns a local model-unavailable response for the experimented public id and MUST NOT silently fall through to default model routing.
- `completed`: historical and non-routing; removed from routing membership and eligible to coexist with a draft or active replacement for the same public id.

Activation MUST validate that the experiment has at least one variant, every variant has positive weight, every variant has a current version effective at or before activation time, and no other active or paused experiment targets the same public id.

Archiving is orthogonal to status. Archiving MUST NOT change routing behavior. Active experiments MUST NOT be archived.

## Structural Edits and Hot Swaps

Experiment structure means the set of variants and their weights. Structural edits are draft-only. After first activation, adding variants, removing variants, or changing weights would shift bucket ranges and corrupt longitudinal cohorts, so those changes MUST require a new experiment.

Variant labels are cosmetic and MAY be edited in non-terminal states. Reports MUST NOT depend on labels as stable identifiers.

A variant is a stable slot. A variant version is the immutable upstream checkpoint/configuration served by that slot at a point in time. Hot-swapping a checkpoint MUST insert a new variant-version row rather than updating an existing version. Version rows MUST NOT be updated in place or deleted by normal admin operations.

Hot swaps MAY occur in `draft`, `active`, or `paused` states. A hot swap preserves a user's variant slot but may change the checkpoint served under that slot for future requests. Request attribution MUST store the selected `variant_version_id` so old requests remain attributable to the exact checkpoint served at routing time. Reports that compare checkpoints MUST group by `variant_version_id`, not only by variant slot.

## Membership Cache

The gateway hot path uses an admin-maintained Redis membership key containing public ids whose experiments are `active` or `paused`, wrapped by a short in-process cache. Redis stores membership only; it MUST NOT store full routing payloads or plaintext partner API keys.

If Redis membership is empty, corrupt, unavailable, or misses a public id, the gateway MUST treat the public id as not experimented rather than performing a Postgres fallback query for every negative hot-path check. This preserves the purpose of the membership cache: most traffic is not experiment traffic.

Admin mutations that move experiments into or out of `active` or `paused` MUST recompute membership. After membership says a public id is experimented, routing details and current variant versions are loaded from Postgres.

## Prompt Storage and Retention

Experiment attribution rows MUST NOT store prompt content in Postgres. They store only request metadata, `request_kind`, a `request_body_sha256` value, and truncation state.

Prompt bodies are stored as full canonical post-transform request bodies in a dedicated per-environment R2 bucket, content-addressed by lowercase sha256. There is one full-body prompt object per unique bounded body; v1 does not store a separate system-prompt object.

Prompt capture is analytics data. Implementations MAY cap the serialized body before retaining it for asynchronous persistence. If truncation is applied, it MUST be deterministic, preserve valid UTF-8, and record `was_truncated = true`. R2 writes are best-effort: attribution rows SHOULD still land when prompt storage fails, using a reserved sentinel.

Valid prompt references are a 64-character lowercase sha256 hex digest or a reserved sentinel. Reserved sentinels are:

- `__failed__`: prompt storage failed, but attribution was retained.
- `__deleted__`: the prompt reference was intentionally wiped while retaining attribution.

Users opt into experiment prompt retention by explicitly selecting a preview/experiment model. A real partner experiment MUST NOT run until the model-specific opt-in/disclosure says prompts may be retained for experiment analysis and partner evaluation and warns users not to submit PII, secrets, customer data, or other sensitive content they do not want retained under that policy.

Experiment prompt data uses its own retention and wipe policy. Default user soft-delete MUST NOT delete experiment attribution rows or R2 prompt objects. A dedicated experiment-data wipe path MUST replace prompt hashes with `__deleted__` and rely on R2 orphan garbage collection for blob cleanup. Automatic retention-window enforcement and R2 orphan GC are deferred v1 follow-ups, not implicit behavior.

## Feedback and Reporting

Experimented requests MUST write one attribution row linked one-to-one to the corresponding usage row when usage exists. Attribution is analytics data and MUST NOT roll back billing if its write fails.

The gateway stores the client request id from `x-kilo-request` when present. Feedback joins use `Feedback Submitted.parentMessageID = model_experiment_request.client_request_id`, and the experiment request row supplies the selected variant-version snapshot.

Reports MUST treat `variant_version_id` as the primary checkpoint-level grouping. `variant_id` is the stable slot; `variant.label` is mutable display text; `upstream.internal_id` comes from the immutable version row. Experiment- and variant-level reports join `request -> variant_version -> variant -> experiment` unless measured query plans justify denormalization.

Reporting views, admin queries, exports, and response payloads MUST explicitly select only the fields they need. They MUST NOT use `SELECT *` across variant-version rows, MUST NOT expose `encrypted_api_key`, and MUST NOT expose plaintext partner API keys.

The v1 reporting surface is intentionally limited. Aggregate live stats, Analytics Engine dimensions, partner trace export, partner replay, and a stable `model_experiment_request_stats` view are excluded until a concrete consumer requires them.

## Secrets and API Keys

Partner API keys MUST NOT be stored in upstream JSON blobs, Redis, prompt bodies, logs, reporting views, admin response payloads, or client-visible responses. They are stored only in the dedicated encrypted key field for a variant version and decrypted only for the selected variant when building the direct upstream provider.

The accepted upstream schema MUST remain a strict allowlisted subset. Arbitrary `extra_headers` are excluded in v1. If a provider later requires a non-secret custom header, add an explicit allowlisted field for that concrete requirement rather than reopening arbitrary header storage.

## V1 Exclusions

The following are intentionally out of scope for v1 and MUST NOT be treated as already guaranteed behavior:

- Production-model traffic splitting or silent assignment from production ids.
- Automatic `kilo-auto` participation for experimented public ids.
- Structural edits after activation.
- Per-request PostHog events for experiment fields.
- Analytics Engine-backed dashboards for experiment dimensions.
- Stable aggregate reporting views unless a concrete consumer is added.
- Partner trace export and replay workflows.
- Automatic prompt retention enforcement and R2 orphan garbage collection.
- Arbitrary upstream headers or plaintext/API-key-bearing upstream payloads.
