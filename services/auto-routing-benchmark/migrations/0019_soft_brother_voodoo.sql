CREATE TABLE `scheduler_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`providers` text NOT NULL,
	`rep` integer NOT NULL,
	`chunk` integer NOT NULL,
	`case_ids` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token` text,
	`slot` integer,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `IX_scheduler_chunks_pending` ON `scheduler_chunks` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `IX_scheduler_chunks_run` ON `scheduler_chunks` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_scheduler_chunks_live_slot` ON `scheduler_chunks` (`slot`) WHERE "scheduler_chunks"."status" IN ('queued', 'active');--> statement-breakpoint
CREATE TABLE `scheduler_executions` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`token` text NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `variant`, `rep`, `case_id`),
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scheduler_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
