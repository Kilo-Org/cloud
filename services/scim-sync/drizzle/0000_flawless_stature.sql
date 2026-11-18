CREATE TABLE `event_failures` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_class` text NOT NULL,
	`last_status` integer,
	`last_error` text NOT NULL,
	`first_failed_at` integer NOT NULL,
	`last_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `parked_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`class` text NOT NULL,
	`status` integer,
	`error` text NOT NULL,
	`attempts` integer NOT NULL,
	`parked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
