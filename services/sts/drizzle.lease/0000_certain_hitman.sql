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
CREATE TABLE `lease` (
	`slot` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lease_id` text,
	`workload` text NOT NULL,
	`caller` text NOT NULL,
	`run_id` text,
	`lease_grant` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`revoke_cause` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lease_lease_id_unique` ON `lease` (`lease_id`);--> statement-breakpoint
CREATE INDEX `lease_workload_created` ON `lease` (`workload`,`created_at`);