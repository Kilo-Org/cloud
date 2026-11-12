# ADR 0003: Efficient Model Pools

## Status

Superseded by [ADR 0005: Custom Auto Routers and Client-Served Models](./0005-custom-auto-routers.md).
Each saved owner pool became a custom router with slug `efficient`; efficient no longer reads
owner settings.

## Context

[ADR 0002](./0002-auto-routing-efficient.md) introduced `kilo-auto/efficient`, a
hidden virtual model backed by a benchmark-driven decision engine that publishes
a single platform routing table. Every request is routed through the same
published table — there is no per-user or per-organization candidate set.

Users and organizations want to constrain `kilo-auto/efficient` to a specific
subset of models they trust or have budget approval for, without forking the
routing infrastructure or introducing a new virtual model ID. They also want
benchmark measurements for those custom subsets without maintaining their own
benchmark pipeline.

## Decision

Introduce **Efficient model pools** as an owner-configurable setting on the
existing `kilo-auto/efficient` virtual model. A pool is a set of 1–10 **pool
entries**, each an exact `(managed model, canonical catalog variant)` pair. Pool
entries select candidates for custom routing; absent or cleared pools restore
platform-default behavior (the published platform efficient routing table).
Balanced is only the gateway fallback when `/decide` returns null (no table,
no ready/compatible selected pair, or an omitted sparse route).

The architecture adds three concepts without a new routing mode or virtual model
id:

1. **Owner pool settings** live in a Durable Object per owner (personal user or
   organization). Mode (efficient/balanced) and pool are committed in one DO
   storage transaction so a mixed save — one field set, the other cleared — can
   never half-apply. Inheritance is independent for mode and pool (organization
   → personal → platform default). Clearing a configured pool restores
   inheritance.

2. **Benchmark profiles** are global measurement records keyed by exact pool
   entry `(model, variant)` plus engine identity. The benchmark worker
   (`services/auto-routing-benchmark`) remains the sole writer of all profiles.
   Profiles are generated on demand when an owner save admits missing or stale
   work, rather than requiring a pre-provisioned catalogue.

3. **Sparse assembled routing tables** are built at decision time from ready
   and current selected profiles. When no selected pair is ready or compatible,
   `/decide` returns null and the gateway falls back to balanced. Platform and
   scheduled decider runs keep publishing the default routing table
   (`ROUTING_TABLE_KV_KEY`); profile runs update profile state only and never
   replace the platform artifact.

## Invariants (what not to change without revisiting this ADR)

1. **Pool entries are exact pairs.** An entry is `(managed model, canonical
   catalog variant)`. Null variant is allowed only for models that expose no
   variants. Profile identity and carried-result gating both use this exact
   pair.

2. **Global profiles, single writer.** Profiles are stored globally (not
   per-owner) in the benchmark worker's D1, keyed by exact pool entry plus
   engine identity. The benchmark worker is the sole writer; the decision engine
   reads profiles through the existing cache chain (isolate → KV → service
   binding to D1) and never writes back.

3. **On-demand generation with admission limits.** Profiles are generated when
   an owner save admits missing or stale work. Admission is limited to 10
   previously unbenchmarked or explicitly retried profiles per owner per rolling
   24 hours, with global deduplication of concurrent exact-pair work. Ready or
   already-pending profiles do not consume request quota.

4. **Single decider slot, shared platform and profile.** Platform and profile
   decider work share the single active decider slot enforced by the partial
   unique index (see ADR 0002 invariant 6). Profile runs fail closed when
   `markProfilesRunningForRun` rejects after insert: the run is marked failed,
   the slot is freed for drain, and no queue work is enqueued. Stale runs sweep
   profile claims along with platform rows.

5. **Platform vs profile publication.** Platform/admin decider runs publish the
   default routing table. Profile runs transition profile state
   (`running` → `ready` / `failed`) and never touch the platform artifact. A
   separate sweep+drain handler ensures a failed final queue message or platform
   run cannot strand pending profile work.

6. **Fail-closed custom decide.** Sparse custom tables omit routes with no
   graded candidates rather than inventing empty lists. Omitted routes yield no
   decision and the gateway's balanced fallback. A configured pool with no
   ready/compatible selected pair likewise returns no decision.

7. **Deploy-order contract.** Production deploys workers as soon as the
   database gate and the change detection finish, in parallel with the Vercel
   staging and promotion jobs, so the previous web release runs against the new
   workers until the promotion lands. A worker change therefore keeps every
   route that the previous web release calls until promotion replaces that
   release: the mode-only `/admin/routing-mode` route stays at every worker
   version, and the Auto routing card keeps saving through it. Pools graduated
   to custom routers (ADR 0005), so the settings compat path this invariant once
   described — the `/admin/routing-settings` 404 fallback and the
   `pool_temporarily_unavailable` retry — no longer exists in the worker or in
   the web client.

8. **Inheritance.** Mode and pool inherit independently (organization →
   personal → platform default). A configured pool does not force the owner into
   efficient mode; a balanced-mode owner with a pool is inert until mode is
   switched. Clearing a configured pool restores inheritance.

## Consequences

Profiles add a new dimension to the benchmark worker's D1 schema (profile
tables, pending-profile queue tables) and a new scheduled sweep handler to
prevent stranded work. The single decider slot shared between platform and
profile work means profile runs compete with platform runs for the slot, but
the admission limits and drain mechanism keep the slot from starving either
purpose.

The deploy-order contract constrains when pool-related routes can land in
workers relative to the web deployment: a worker ships first, so it keeps the
routes the previous web release calls. Pool settings are additive to the
existing worker schema; rollback to pre-pool workers runs prior code against
the migrated schema (migration 0005 rebuilds `case_results` / `model_summaries`
/ `run_models` with generated rebuild SQL preserving legacy rows; 0006/0007 are
additive profile and pending-profile tables).

## References

- [ADR 0002: Benchmark-Driven Auto Routing](./0002-auto-routing-efficient.md) —
  the base efficient routing decision that pools extend.
