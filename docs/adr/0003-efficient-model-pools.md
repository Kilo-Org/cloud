# ADR 0003: Efficient Model Pools

## Status

Accepted

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

7. **Deploy-order contract.** Production promotes the Vercel web deployment
   *before* deploying workers, so every merge runs new web against old workers
   for the worker build window. During that window,
   `GET /admin/routing-settings` 404s on old workers; the web BFF synthesizes
   the settings response from the legacy `/admin/routing-mode` route with
   `poolSupported: false` (no pool annotation), and the Auto routing card hides
   pool controls and saves mode-only through the legacy web mode route —
   mode-only at every worker version, never touching pool keys. A settings PUT
   that 404s (mid-session worker rollback from a supported UI) answers a
   retryable 503 `pool_temporarily_unavailable` for every body shape; there is
   deliberately no legacy PUT fallback, because `pool: null` from a supported UI
   is clear intent an old worker cannot honor (it would silently preserve the
   pool), and a stale unsupported-UI body must never reach a new worker's
   settings PUT (it would silently clear the pool).

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
workers relative to the web deployment. Pool settings are additive to the
existing worker schema; rollback to pre-pool workers runs prior code against
the migrated schema (migration 0005 rebuilds `case_results` / `model_summaries`
/ `run_models` with generated rebuild SQL preserving legacy rows; 0006/0007 are
additive profile and pending-profile tables).

## References

- [ADR 0002: Benchmark-Driven Auto Routing](./0002-auto-routing-efficient.md) —
  the base efficient routing decision that pools extend.
