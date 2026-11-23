CREATE TABLE `session_sources` (
	`source_id` text PRIMARY KEY NOT NULL,
	`client` text DEFAULT 'cli' NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `entities` ADD `source_id` text;--> statement-breakpoint
ALTER TABLE `receipts` ADD `source_id` text;