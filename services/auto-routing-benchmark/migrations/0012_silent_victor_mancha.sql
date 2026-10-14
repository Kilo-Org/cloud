CREATE TABLE `profile_benchmark_admissions` (
	`admission_id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IDX_profile_benchmark_admissions_state` ON `profile_benchmark_admissions` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `profile_benchmark_claims` (
	`admission_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`estimated_cost_usd` real NOT NULL,
	`charged_cost_usd` real,
	`quota_charged` integer NOT NULL,
	`state` text NOT NULL,
	`terminal_status` text,
	`run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`settled_at` text,
	PRIMARY KEY(`admission_id`, `model`, `variant`),
	FOREIGN KEY (`admission_id`) REFERENCES `profile_benchmark_admissions`(`admission_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_profile_benchmark_claims_active_pair` ON `profile_benchmark_claims` (`model`,`variant`,`engine_identity`,`repetitions`) WHERE "profile_benchmark_claims"."state" IN ('allocating', 'admitted') AND "profile_benchmark_claims"."terminal_status" IS NULL;--> statement-breakpoint
CREATE INDEX `IDX_profile_benchmark_claims_run` ON `profile_benchmark_claims` (`run_id`,`state`);--> statement-breakpoint
CREATE INDEX `IDX_profile_benchmark_claims_state` ON `profile_benchmark_claims` (`state`,`created_at`);