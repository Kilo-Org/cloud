# Reduce Cost Insights Database Impact

## Goal

Reduce Cost Insights database pressure without changing user-facing semantics. Spend Alerts remain alert-only, Cost Suggestions remain advisory, rollup capture stays atomic with Credit spend, and the hourly sweep remains the correctness backstop.

## Implementation Scope

- Debounce normal post-spend dirty-owner evaluation by 60 seconds while preserving owner coalescing and generation increments.
- Keep explicit settings enable and re-enable flows immediate through the existing direct evaluator call.
- Load owner config before expensive evidence reads and skip suggestion or threshold windows when disabled or unconfigured.
- Use rollup-backed current-hour anomaly evidence when rollup coverage is healthy, with canonical aggregation fallback when coverage is incomplete or degraded.
- Add generated-schema indexes for fallback reads on `exa_usage_log` and negative `credit_transactions`.
- Emit aggregate operational telemetry for queue depth, duration, canonical fallback count, hourly sweep owner count, deadline state, and degraded rollup intervals.

## Verification

- Run `pnpm drizzle generate` after schema edits.
- Run targeted Cost Insights tests.
- Run `scripts/typecheck-all.sh --changes-only`.
- Run `pnpm format` before finishing.
