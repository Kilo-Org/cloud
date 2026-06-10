# Experimental Models — Part 2: Partner Trace Export & Replay Roadmap

> **STATUS: VERY WIP — needs human iteration.** This document is an early
> sketch of the partner trace export and replay roadmap. It has not been
> grilled to the same level of detail as Part 1: scope boundaries, redaction
> rules, partner auth model, webhook contract, warehouse coordination, and
> replay-bundle format are all open questions. Do **not** treat this as an
> implementation-ready plan. Expect significant rework after design review
> with humans.

> **Scope: preview/experimental models only.** Trace export, redaction, and
> partner webhooks here apply exclusively to traffic on opt-in preview model
> ids defined by Part 1. Production traffic and non-experimented model ids are
> never exported to partners.

> Prerequisite: [Part 1 — Core A/B Experiment System](./experimental-models-1.md)

This plan covers trace export for model provider partnerships and the future replay evaluation roadmap. It depends on the core experiment infrastructure built in Part 1.

## Implementation Plan

### Phase 6 — Partner Trace Export (v1)

This phase delivers trace export and live partner reporting. Replay bundles are explicitly future work.

Current capture facts:

- Cloud session sync is on by default for authenticated kilocode users; opt-out is `KILO_DISABLE_SESSION_INGEST`.
- The ingest path captures higher-fidelity data than local read paths because the `message-v2.ts` strippers do not run before queue publishing.
- Items above ~1.94 MiB go to R2; items above 50 MiB are dropped by the current queue consumer.

V1 deliverables:

- `services/partner-export/` queue consumer and batch job.
- Live export from session-ingest items to partner R2 prefixes such as `partner/{partnerId}/traces/{ymd}/{sessionId}.jsonl`.
- Feedback export via a `partner-feedback-events` queue keyed by PostHog `Feedback Submitted.parentMessageID` joins.
- Shared live/batch filter: select sessions via `model_experiment_request` rows for partner experiment variants, then emit only turns served by the partner's checkpoint to avoid cross-model session contamination.
- Redactor MVP before export: high-entropy/known-secret regexes, `.env` values, email regex, path normalization, SSH credential stripping, repo URL hashing, and `redactor_version` stamping.
- Partner webhook delivery: HMAC-signed payloads, retry, dead-letter queue, and delivery log.
- Warehouse passthrough: coordinate with `kilocode-dbt` to expose `model_experiment_request` fields on the enriched usage model.
- Partner dashboard: `apps/web/src/app/partners/{partnerId}/experiments/{id}/page.tsx`, backed by scoped live stats, feedback counts, and the checkpoint timeline.
- Partner auth scope: add `partner_membership(user_id, partner_id, role)` in the schema work.

Consent handling:

- Reuse the upstream eval-program mechanism; do not build a parallel consent surface.
- A partnership model's catalog row must be flagged `eval_program=true` when the experiment is active.
- The partner-export filter respects the same session sync / training-data consent fields as the eval-program mechanism.

### Phase 7 — Replay Roadmap (Future)

Replay bundles, SWE-bench/OpenHands adapters, and held-out replay-eval are out of scope for v1 because key capture artifacts do not exist yet. Required follow-on work lives mostly in the kilocode CLI repo:

| Gap | Required capture |
|---|---|
| Resolved agent config | `agent_snapshot` ingest item per user-message turn with canonical hash and `Agent.Info`. |
| Lossless part bodies | `part_raw` ingest path with checksum and no read-path stripping. |
| Workspace reconstruction | `workspace_ref` at session start with sanitized git remote, base commit, branch, dirty-start diff, and touched paths. |
| Per-step replay | `step_diff` items with full file diffs, including patch text. |
| Retry analytics | Structured `RetryPart` producer rather than only session-level `"retry"` status. |

Future packages/services:

- `packages/replay-builder/` — replay bundle assembly and SWE-bench-format task pack emission.
- `services/replay-eval/` — held-out replay-eval-as-a-service runner.
- `packages/replay-builder/docs/integrations/{gymnasium,swe-gym,openhands,inspect-ai}.md` — field mappings and examples.

## Risk Areas

- Cross-model sessions: partner trace export must emit only turns served by the partner checkpoint, not unrelated turns from the same session.
- Capture fidelity: current session ingest drops items above 50 MiB without an explicit session marker; partner export should either raise this for eligible sessions or report dropped-part counts.

## Files Touched

Partner export additions:

- `services/partner-export/`
- `packages/redactor/` or a co-located redactor inside `services/partner-export/`
- `apps/web/src/routers/admin/partner-export-router.ts`
- `apps/web/src/routers/partners/partner-experiments-router.ts`
- `apps/web/src/app/partners/{partnerId}/experiments/{id}/page.tsx`

Outside this repo:

- `kilocode-dbt`: join/passthrough `model_experiment_request` fields into the enriched usage model.
- Kilocode CLI repo: future replay capture artifacts (`agent_snapshot`, `part_raw`, `workspace_ref`, `step_diff`).
