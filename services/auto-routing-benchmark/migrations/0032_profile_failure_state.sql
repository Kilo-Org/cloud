ALTER TABLE `benchmark_profiles` ADD `failure_class` text;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `failure_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `model_failure_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `first_failed_at` text;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `retry_after` text;--> statement-breakpoint
ALTER TABLE `run_lane_failures` ADD `failure_class` text;--> statement-breakpoint
ALTER TABLE `scheduler_chunks` ADD `catalog_deferrals` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `benchmark_profiles` SET `status` = 'unavailable',
  `failure_class` = CASE
    WHEN `failure_reason` LIKE 'Model context window leaves fewer than %' THEN 'context_too_small'
    WHEN `failure_reason` LIKE 'Exact benchmark model or variant is unavail%' THEN 'model_not_found'
    ELSE 'catalog_absent' END,
  `failure_attempts` = 1,
  `first_failed_at` = COALESCE(`completed_at`, `updated_at`)
WHERE `status` = 'failed' AND (
  `failure_reason` IN (
    'Model or variant is unavailable in the executable benchmark catalog.',
    'Model or variant is unavailable to the benchmark CLI.'
  )
  OR `failure_reason` LIKE 'Model context window leaves fewer than %'
  OR `failure_reason` LIKE 'Exact benchmark model or variant is unavail%'
);--> statement-breakpoint
UPDATE `benchmark_profiles` SET
  `failure_class` = CASE
    WHEN `failure_reason` = 'timed out' THEN 'run_timed_out'
    WHEN `failure_reason` LIKE 'Benchmark run ended without settling%' THEN 'orphaned_claim'
    WHEN `failure_reason` LIKE 'scheduler initialization failed:%'
      OR `failure_reason` LIKE 'case reuse failed:%'
      OR `failure_reason` LIKE 'enqueue failed%'
      OR `failure_reason` = 'Benchmark run is missing its execution identity.' THEN 'run_init_failed'
    ELSE 'unknown' END,
  `failure_attempts` = 1,
  `first_failed_at` = COALESCE(`completed_at`, `updated_at`),
  `retry_after` = COALESCE(`completed_at`, `updated_at`)
WHERE `status` = 'failed';