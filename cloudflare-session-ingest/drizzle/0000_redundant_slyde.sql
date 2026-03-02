CREATE TABLE IF NOT EXISTS `ingest_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ingest_items_item_id_unique` ON `ingest_items` (`item_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ingest_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`session_id` text PRIMARY KEY NOT NULL
);
