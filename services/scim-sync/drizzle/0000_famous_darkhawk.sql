CREATE TABLE `poll_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_event_created_at` text,
	`range_start` text,
	`last_polled_at` integer,
	`last_event_at` integer,
	`events_seen` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
