CREATE TABLE `client_case_results` (
	`profile_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rep` integer NOT NULL,
	`route_key` text NOT NULL,
	`output` text NOT NULL,
	`cost_usd` real NOT NULL,
	`duration_ms` integer NOT NULL,
	`exit_code` integer,
	`timed_out` integer NOT NULL,
	`score` real NOT NULL,
	`grader_cost_usd` real NOT NULL,
	`uploaded_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `case_id`, `rep`),
	FOREIGN KEY (`profile_id`) REFERENCES `client_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `client_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`router` text NOT NULL,
	`entry_kind` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`results` integer DEFAULT 0 NOT NULL,
	`accuracy` real,
	`errors` integer DEFAULT 0 NOT NULL,
	`timeouts` integer DEFAULT 0 NOT NULL,
	`avg_cost_usd` real,
	`p50_latency_ms` real,
	`p95_latency_ms` real,
	`route_summaries` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_client_profiles_identity` ON `client_profiles` (`owner_type`,`owner_id`,`router`,`entry_kind`,`provider`,`model`,`variant`,`engine_identity`,`repetitions`);--> statement-breakpoint
DROP INDEX `IDX_profile_request_events_owner_admitted`;--> statement-breakpoint
ALTER TABLE `profile_request_events` ADD `router` text DEFAULT 'efficient' NOT NULL;--> statement-breakpoint
CREATE INDEX `IDX_profile_request_events_owner_router_admitted` ON `profile_request_events` (`owner_type`,`owner_id`,`router`,`admitted_at`);