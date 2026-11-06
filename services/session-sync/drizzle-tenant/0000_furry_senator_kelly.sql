CREATE TABLE IF NOT EXISTS `leases` (
	`session_id` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`sessions` integer NOT NULL,
	`bytes` integer NOT NULL
);
