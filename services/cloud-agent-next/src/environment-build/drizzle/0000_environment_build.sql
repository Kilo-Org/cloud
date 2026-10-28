CREATE TABLE `auto_attempts` (
	`revision` integer PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`last_failure_at` integer,
	`last_admitted_at` integer
);
--> statement-breakpoint
CREATE TABLE `build_logs` (
	`build_id` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`build_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`revision` integer NOT NULL,
	`trigger` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`input` text NOT NULL,
	`encrypted_secrets` text,
	`instance` text NOT NULL,
	`runtime_release` text,
	`state` text NOT NULL,
	`outcome` text,
	`failure_reason` text,
	`failure_detail` text,
	`allocation_id` text,
	`credential_hash` text,
	`launched_at` integer,
	`last_heartbeat_at` integer,
	`last_event_sequence` integer,
	`runner_step` text,
	`source_commit` text,
	`source_branch` text,
	`setup_duration_ms` integer,
	`capture_id` text,
	`capture_result` text,
	`cleanup_attempts` integer NOT NULL,
	`cleanup_error` text,
	`next_cleanup_at` integer,
	`log_seq` integer NOT NULL,
	`log_bytes` integer NOT NULL,
	`log_truncated` integer NOT NULL,
	`stage_times` text NOT NULL,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `builds_request_id` ON `builds` (`request_id`);--> statement-breakpoint
CREATE INDEX `builds_state` ON `builds` (`state`);--> statement-breakpoint
CREATE INDEX `builds_created_at` ON `builds` (`created_at`);--> statement-breakpoint
CREATE TABLE `environment` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `published_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`descriptor` text NOT NULL
);
