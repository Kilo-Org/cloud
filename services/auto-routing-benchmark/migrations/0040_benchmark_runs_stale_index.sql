-- A partial index for the per-minute stale-run sweep: every running run older than the
-- stale age is failed by one UPDATE guarded on `status` and `started_at`, and the only
-- declared `benchmark_runs` indexes are the partial unique classifier index and
-- `IX_benchmark_runs_running` (router, kind, purpose), neither of which can serve it.
-- Partial over `status = 'running'` because that is the only part the sweep reads, and the
-- running set is a handful of rows however large the run history grows. The migration
-- numeral is provisional: it is renumbered at merge.
CREATE INDEX `IX_benchmark_runs_stale` ON `benchmark_runs` (`started_at`) WHERE "benchmark_runs"."status" = 'running';
