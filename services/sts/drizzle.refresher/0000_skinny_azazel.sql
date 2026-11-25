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
CREATE TABLE `manager_folder` (
	`folder` text PRIMARY KEY NOT NULL,
	`etag` text,
	`fetched_at` integer NOT NULL,
	`iv` text NOT NULL,
	`ciphertext` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refresher_key` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refresher_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_refresh_at` integer NOT NULL,
	`failures` integer NOT NULL,
	`webhook_refresh_at` integer,
	`last_refresh_at` integer
);
--> statement-breakpoint
CREATE TABLE `webhook_key` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
