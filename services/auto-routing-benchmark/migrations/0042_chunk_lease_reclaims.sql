DROP INDEX `IX_scheduler_chunks_run`;--> statement-breakpoint
ALTER TABLE `scheduler_chunks` ADD `lease_reclaims` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `IX_scheduler_chunks_run_id` ON `scheduler_chunks` (`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `plan_fingerprint` text;