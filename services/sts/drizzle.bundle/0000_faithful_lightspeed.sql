CREATE TABLE `audit_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_watermark` (
	`id` integer PRIMARY KEY NOT NULL,
	`relayed_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bundle` (
	`id` integer PRIMARY KEY NOT NULL,
	`workload` text NOT NULL,
	`environment` text NOT NULL,
	`etag` text NOT NULL,
	`policy_hash` text NOT NULL,
	`fetched_at` text NOT NULL,
	`stale` integer NOT NULL,
	`missing` text NOT NULL,
	`iv` text NOT NULL,
	`ciphertext` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bundle_key` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_counter` (
	`minute` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL
);
