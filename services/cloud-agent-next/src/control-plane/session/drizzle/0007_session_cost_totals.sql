CREATE TABLE `cost_backfill_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`complete` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_cost_totals` (
	`session_id` text NOT NULL,
	`kilo_session_id` text NOT NULL,
	`total_dollars` real NOT NULL,
	PRIMARY KEY(`session_id`, `kilo_session_id`)
);
