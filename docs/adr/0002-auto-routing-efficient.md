# ADR 0002: Benchmark-Driven Auto Routing (`kilo-auto/efficient`)

## Status

Accepted

## Context

`kilo-auto/*` virtual models route a request to a concrete model on the user's
behalf. The existing `balanced` tier picks a single fixed default (Qwen). We want
a tier that routes each request to the *cheapest model proven accurate enough for
that request's difficulty*, where "proven" means measured by our own benchmarks
rather than asserted by hand.

This requires three capabilities the codebase did not have: a way to benchmark
candidate models reproducibly, a way to turn benchmark results into a routing
decision per request, and a way to bill the routing overhead honestly. The model
must ship hidden so it can be validated on Kilo team traffic before it competes
with `balanced` for real users.

## Decision

Introduce a hidden virtual model `kilo-auto/efficient` backed by a
benchmark-driven decision engine. Ownership is split across three components with
strict, one-directional dependencies:

- **`services/auto-routing-benchmark`** (new worker) owns *measurement and
  publication*. It runs the classifier and decider benchmarks, stores normalized
  results in its own D1, and publishes two artifacts: a per-difficulty-tier
  routing table and a classifier winner. It is the **sole writer** of both.
- **`services/auto-routing`** owns *the per-request decision*. Its `/decide`
  endpoint classifies the request, derives a difficulty tier, and reads (never
  writes) the published artifacts to pick a model. Session stickiness lives in a
  Durable Object here.
- **`apps/web` gateway** owns *exposure and billing*. It resolves
  `kilo-auto/efficient`, blocks on `/decide`, falls back to balanced Qwen, bills
  the classifier cost, and hosts the admin panel (proxied to the benchmark worker
  with the internal secret).

Shared request-classification code (prompt, parsing, taxonomy, tier derivation,
routing-table schema) lives in `packages/auto-routing-contracts` so the benchmark
replays the exact code production runs.

## Invariants (what not to change without revisiting this ADR)

1. **The benchmark worker is the only writer of routing tables and the classifier
   winner.** The decision engine and gateway read them through a cache chain
   (isolate 60s → KV 1h → service binding to D1) and never write back.
2. **No fabricated data.** There is no default routing table and no default
   benchmark config. `/decide` returns a null decision until a benchmark
   publishes a table; the gateway then serves the balanced fallback. Runs refuse
   to start without a saved config; decider runs additionally require a
   `benchmarkUserId`.
3. **Graceful degradation at every layer.** Corrupt KV → treated as a miss;
   origin failure → previous behavior (stale table stays live); classifier
   failure / `/decide` timeout (2s) → null decision → balanced fallback; publish
   with any empty tier → skipped, previous table stays live. An
   `efficient` request must never degrade *below* balanced.
4. **Results are reproducible.** Grading is mechanical only (`exact` /
   `contains_all` / `regex` / `json_equal`), never LLM-judged. Each run snapshots
   its config (`min_accuracy`, `switch_cost_factor`, `max_concurrency`,
   `benchmark_user_id`, per-model `reasoning_effort`); all processing and
   publishing reads the snapshot, not live config.
5. **Carried results are identity-gated.** A prior model's summaries are reused on
   a new run only when the engine identity (dataset + grading/CLI version),
   repetition count, and the model's `reasoning_effort` all match. Any change
   re-benchmarks the affected model rather than silently mixing incomparable
   numbers.
6. **One active run per kind.** A partial unique index plus a server-side check
   admit at most one `running` classifier and one `running` decider run; a second
   start returns 409, not 500. Stale runs are swept to `failed` on run listing.
7. **The model stays hidden** (excluded from `/models`, usable by id) until team
   validation graduates it. Graduation criteria live in the rollout section
   below, not in code.
8. **Token boundary.** The decider CLI authenticates as a real Kilo user via a 6h
   token minted by `apps/web`'s internal endpoint (gated by
   `INTERNAL_API_SECRET`). The token only ever lives in a child-process env var —
   never logged, never written to disk.

## Billing policy

The classifier LLM runs on Kilo's OpenRouter credential during model resolution,
so its cost is owed regardless of how the request ends. It is billed as a separate
microdollar usage row (`requested_model: kilo-auto/efficient`, model
`auto-routing/classifier`) to the authenticated requesting user, scheduled as soon
as auth resolves so it survives every downstream rejection path (abuse block,
provider/api-kind rejection, balance/org checks, upstream 4xx). It is billed even
when the final inference is BYOK (the classifier was not BYOK). It is skipped
entirely for anonymous requests (which never reach a paid classification) and is
deliberately excluded from generic first-usage lifecycle events so the overhead
row cannot be mis-attributed as a user's first model.

## Sticky-session rule

A conversation's Durable Object remembers the last served model. The incumbent is
kept while it still meets the tier's accuracy threshold, unless the fresh pick is
cheaper by more than the table's `switchCostFactor`. Rationale: a model switch
discards the provider's prompt cache, and rebuilding it costs full-price input
tokens (4–10× cache-read rates) on a context that dominates agent-session spend —
switching only pays off when recurring per-turn savings clearly exceed that
one-time penalty. Stickiness trusts only real classifier output; heuristic
fallbacks never re-anchor the session's model.

## Alternatives considered

- **Reuse the model-experiment tooling.** Model experiments are explicit,
  user-selected preview ids; per `.specs/model-experiments.md` they must never
  enter automatic `kilo-auto` candidate sets (enforced at config-save time). They
  give no per-difficulty accuracy/cost signal and no routing table, so they cannot
  drive automatic routing.
- **Offline benchmarks + hand-maintained routing tables.** Rejected: a
  hand-maintained table is fabricated data that drifts from reality, has no
  reproducible provenance, and cannot be re-derived after a model or prompt
  change. Making the benchmark the source of truth is the whole point.
- **A narrower first PR (e.g. classifier-only, or routing without benchmarks).**
  Considered, but the pieces are not independently useful: a routing engine with
  no published table has nothing to route from, and a benchmark with no consumer
  publishes into the void. The smallest *shippable* unit is the full loop behind a
  hidden model — which is why it ships hidden rather than as smaller live
  increments.
- **LLM-judged grading.** Rejected for reproducibility: re-running a benchmark
  must yield comparable numbers. Mechanical checks are deterministic; golden
  answers were hand-derived and mechanically re-verified.

## Rollout / cutover

1. Gateway side ships with the merge (Vercel): the hidden model, admin panel, and
   token mint.
2. The first post-merge worker deploy applies the D1 migration via the CI
   predeploy hook (`wrangler d1 migrations apply --remote`); CI's
   `CLOUDFLARE_API_TOKEN` needs D1 edit permission.
3. An admin saves a benchmark config (decider runs require `benchmarkUserId` —
   prefer a dedicated service account, as it is billed for CLI usage) and triggers
   a classifier and a decider run.
4. Graduation from hidden to broader use is a judgement call made on team traffic;
   target signals are a measured cost reduction versus balanced at
   non-inferior accuracy, and no regression in fallback rate. These live here, not
   in code, so changing them is a deliberate decision.

### Rollback

`kilo-auto/efficient` is hidden and additive, so rollback is containment, not
revert:

- **Disable the model**: stop routing to it. Because it is hidden, no `/models`
  consumer depends on it; the gateway already serves balanced on any null
  decision, so forcing null decisions (or reverting the gateway deploy) degrades
  cleanly to balanced.
- **Clear published artifacts**: delete the routing-table and classifier-winner
  KV keys in `AUTO_ROUTING_CONFIG`; `/decide` then returns null until a benchmark
  republishes, i.e. balanced fallback everywhere.
- **Stop benchmark activity**: pause/avoid triggering runs from the admin panel;
  in-flight queue jobs drain or fail into the DLQ (see the service README).
- **Worker rollback**: redeploy the previous `auto-routing` / `auto-routing-bench`
  worker versions. The D1 schema is additive; if a predeploy migration fails the
  deploy fails before serving, leaving the prior version live.

## Consequences

This adds a new worker, D1 schema, queue + DLQ, container runner, gateway routing,
billing path, and admin UI in one merge. The cost is a large surface landing
together; the benefit is that the surface is the smallest *coherent* one (each
piece is inert without the others) and it lands hidden, so production exposure is
gated on explicit team validation. The benchmark-as-source-of-truth design means
routing decisions are always traceable to a reproducible run, and adding a
candidate model re-benchmarks only that model rather than the whole set.

Operational ownership and local-dev/DLQ debugging live in
`services/auto-routing-benchmark/README.md`.
