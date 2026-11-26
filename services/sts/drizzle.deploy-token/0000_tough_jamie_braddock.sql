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
CREATE TABLE `deploy_token` (
	`slot` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` text,
	`workload` text NOT NULL,
	`caller` text NOT NULL,
	`run_id` text NOT NULL,
	`permission_set` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`delete_cause` text,
	`delete_retry_at` integer,
	`delete_attempts` integer DEFAULT 0 NOT NULL,
	`delete_failure_audited` integer DEFAULT false NOT NULL,
	`intended_scripts` text NOT NULL,
	`scripts_checked` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deploy_token_token_id_unique` ON `deploy_token` (`token_id`);--> statement-breakpoint
CREATE INDEX `deploy_token_workload_created` ON `deploy_token` (`workload`,`created_at`);--> statement-breakpoint
CREATE TABLE `deploy_token_sweep` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_sweep_at` integer NOT NULL,
	`page` integer
);
