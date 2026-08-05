# Benchmark profile D1 fixtures for owner-pool E2E (auto-routing)

Deterministic fixtures for `services/auto-routing-benchmark` local D1 (verified 2026-07-28):

- Engine identity is deterministic: `computeEngineIdentity('decider')` → `v1:8f2eee90`
  (run `pnpm exec tsx -e "import {computeEngineIdentity} from './src/run.ts'; console.log(computeEngineIdentity('decider'))"`
  from the service dir). Seed `benchmark_profiles.engine_identity` with exactly this value and
  `repetitions` matching `benchmark_config.decider_repetitions`, or rows are stale and auto re-admit.
- `benchmark_config.switch_cost_factor` must be >= 1 (`BenchmarkConfigSchema` zod min 1). A seeded 0.1
  makes `/admin/custom-routing-table` 500 (ZodError at buildCustomRoutingTable), which
  `loadCustomRoutingTable` converts to a SILENT null table → decide returns null → gateway serves
  the balanced fallback (qwen/qwen3.7-plus) with no product error. Symptom looks like "pool ignored".
- `benchmark_config` alone is not enough: `getBenchmarkConfig` returns null (→ 400 on all profile
  endpoints) unless `config_classifier_models` and `config_decider_models` each have >= 1 row.
- Custom table assembly needs BOTH ready `benchmark_profiles` rows (with `run_id`) AND
  `model_summaries` rows for that exact run_id + exact (model, variant) pair (provenance binding).
- Profile status lookup auto re-admits stale rows as pending WITHOUT charging
  `profile_request_events` — verify ledger count stays flat across engine-drift.
- Generate multi-statement SQL with node, not a shell for-loop: zsh does NOT word-split an unquoted
  `$VAR` (`for R in $ROUTES` iterates once with the whole string), producing one garbage row key.
