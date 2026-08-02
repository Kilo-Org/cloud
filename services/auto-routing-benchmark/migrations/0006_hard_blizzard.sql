CREATE TABLE `benchmark_profiles` (
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`failure_reason` text,
	`requested_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`model`, `variant`, `engine_identity`, `repetitions`)
);
--> statement-breakpoint
CREATE TABLE `profile_request_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`admitted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IDX_profile_request_events_owner_admitted` ON `profile_request_events` (`owner_type`,`owner_id`,`admitted_at`);