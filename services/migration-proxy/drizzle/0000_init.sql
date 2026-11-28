CREATE TABLE `audit_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_prune` (
	`id` integer PRIMARY KEY NOT NULL,
	`pruned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_watermark` (
	`id` integer PRIMARY KEY NOT NULL,
	`relayed_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `denial_windows` (
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`minute` integer NOT NULL,
	PRIMARY KEY(`reason`, `actor`, `minute`)
);
--> statement-breakpoint
CREATE TABLE `github_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_verdicts` (
	`path` text NOT NULL,
	`blob` text NOT NULL,
	`pr` integer NOT NULL,
	`approver` text NOT NULL,
	PRIMARY KEY(`path`, `blob`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`state` text NOT NULL,
	`phase` text NOT NULL,
	`sha` text NOT NULL,
	`attested_sha` text NOT NULL,
	`github_run_id` text NOT NULL,
	`github_run_attempt` text NOT NULL,
	`event_name` text NOT NULL,
	`job_workflow_ref` text NOT NULL,
	`workload` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`heartbeat_at` integer,
	`pending` text NOT NULL,
	`applied` text NOT NULL,
	`failure` text,
	`journal_blob` text,
	`files` text,
	`review_base` text,
	`reviewed` text,
	`stalled_alarms` integer DEFAULT 0 NOT NULL,
	`progress_at` integer NOT NULL,
	`github_retry_at` integer,
	`container_started_at` integer,
	`apply_sent` integer DEFAULT false NOT NULL,
	`lost_ticks` integer DEFAULT 0 NOT NULL,
	`terminated_sessions` integer,
	`unexpected_sessions` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_id_unique` ON `runs` (`id`);--> statement-breakpoint
CREATE INDEX `runs_state` ON `runs` (`state`);--> statement-breakpoint
CREATE INDEX `runs_attempt` ON `runs` (`github_run_id`,`github_run_attempt`);--> statement-breakpoint
CREATE TABLE `samples` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `session_pairs` (
	`pid` integer NOT NULL,
	`backend_start` text NOT NULL,
	`owner` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`pid`, `backend_start`)
);
