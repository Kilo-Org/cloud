ALTER TABLE `benchmark_runs` ADD `plan_fingerprint` text;--> statement-breakpoint
ALTER TABLE `scheduler_chunks` ADD `lease_reclaims` integer DEFAULT 0 NOT NULL;