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
-- 2. Adopt every measurement an earlier decider run already paid for into the
--    registry, so no model that was measured with real money is benchmarked
--    again. Provenance points at the run whose model_summaries hold the
--    numbers; ORDER BY started_at DESC plus the status guard on the upsert
--    keeps the newest run per exact pair.
--
--    Failed runs are read too, and that is the point. Until this migration one
--    dead lane failed the whole run, so a run that graded every case for 32 of
--    its 33 models left all 33 rows `failed` with the results unused.
--
--    A pair is adopted only when it is whole: no dead lane of its own, and
--    `repetitions` x 180 graded cases. 180 is the decider dataset size that
--    `engine_identity` pins, so a partly measured pair — the real hazard in a
--    run that timed out — can never be published as a finished candidate.
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
  `ms`.`model`,
  `ms`.`variant`,
  `r`.`engine_identity`,
  `r`.`repetitions`,
  'ready',
  `r`.`id`,
  NULL,
  `r`.`started_at`,
  COALESCE(`r`.`completed_at`, `r`.`started_at`),
  COALESCE(`r`.`completed_at`, `r`.`started_at`),
  `r`.`purpose` = 'platform',
  `r`.`purpose` <> 'platform'
FROM `benchmark_runs` `r`
JOIN `model_summaries` `ms` ON `ms`.`run_id` = `r`.`id`
WHERE `r`.`kind` = 'decider'
  AND `r`.`status` IN ('completed', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM `run_lane_failures` `lf`
    WHERE `lf`.`run_id` = `r`.`id`
      AND `lf`.`model` = `ms`.`model`
      AND `lf`.`variant` = `ms`.`variant`
  )
GROUP BY `r`.`id`, `ms`.`model`, `ms`.`variant`
HAVING SUM(`ms`.`cases`) = `r`.`repetitions` * 180
ORDER BY `r`.`started_at` DESC
ON CONFLICT (`model`, `variant`, `engine_identity`, `repetitions`) DO UPDATE SET
  `status` = 'ready',
  `run_id` = excluded.`run_id`,
  `failure_reason` = NULL,
  `updated_at` = excluded.`updated_at`,
  `completed_at` = excluded.`completed_at`,
  `platform_requested` = `benchmark_profiles`.`platform_requested` OR excluded.`platform_requested`
WHERE `benchmark_profiles`.`status` IN ('pending', 'failed');
