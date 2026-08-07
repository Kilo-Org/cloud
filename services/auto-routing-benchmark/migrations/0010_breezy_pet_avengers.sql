DROP INDEX `UQ_benchmark_runs_one_running_per_kind`;--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_benchmark_runs_one_running_per_kind_purpose` ON `benchmark_runs` (`kind`,`purpose`) WHERE "benchmark_runs"."status" = 'running';--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `user_max_concurrency` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `platform_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `user_requested` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Data migration (hand-appended to the drizzle-generated DDL above).
--
-- 1. Runs that drained owner-pool work were tagged 'profile'; the purpose column
--    now names the queue, and that queue is 'user'.
UPDATE `benchmark_runs` SET `purpose` = 'user' WHERE `purpose` = 'profile';--> statement-breakpoint
-- 2. Adopt every measurement a completed platform run already paid for into the
--    registry, so the platform routing table keeps its candidates instead of
--    re-benchmarking models that were measured with real money. Provenance
--    points at the run whose model_summaries hold the numbers; ORDER BY
--    started_at DESC keeps the newest run per exact pair.
--
--    An owner pool may already hold a row for the same pair. A `pending` or
--    `failed` row there means the measurement was going to be paid for again,
--    so adopt the existing result into it. `ready` rows are left alone (they
--    already have provenance) and so are `running` ones (a live run owns them
--    and must stay able to settle its own entries).
INSERT INTO `benchmark_profiles` (
  `model`, `variant`, `engine_identity`, `repetitions`, `status`, `run_id`,
  `failure_reason`, `requested_at`, `updated_at`, `completed_at`,
  `platform_requested`, `user_requested`
)
SELECT
  `rm`.`model`,
  `rm`.`variant`,
  `r`.`engine_identity`,
  `r`.`repetitions`,
  'ready',
  `r`.`id`,
  NULL,
  `r`.`started_at`,
  COALESCE(`r`.`completed_at`, `r`.`started_at`),
  COALESCE(`r`.`completed_at`, `r`.`started_at`),
  true,
  false
FROM `benchmark_runs` `r`
JOIN `run_models` `rm` ON `rm`.`run_id` = `r`.`id`
WHERE `r`.`kind` = 'decider'
  AND `r`.`purpose` = 'platform'
  AND `r`.`status` = 'completed'
  AND EXISTS (
    SELECT 1 FROM `model_summaries` `ms`
    WHERE `ms`.`run_id` = `r`.`id`
      AND `ms`.`model` = `rm`.`model`
      AND `ms`.`variant` = `rm`.`variant`
  )
ORDER BY `r`.`started_at` DESC
ON CONFLICT (`model`, `variant`, `engine_identity`, `repetitions`) DO UPDATE SET
  `status` = 'ready',
  `run_id` = excluded.`run_id`,
  `failure_reason` = NULL,
  `updated_at` = excluded.`updated_at`,
  `completed_at` = excluded.`completed_at`,
  `platform_requested` = 1
WHERE `benchmark_profiles`.`status` IN ('pending', 'failed');
