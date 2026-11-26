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
