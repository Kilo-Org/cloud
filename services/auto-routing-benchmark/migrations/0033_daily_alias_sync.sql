CREATE TABLE `benchmark_daily_alias_sync` (
	`router` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`platform_status` text DEFAULT 'pending' NOT NULL,
	`platform_error` text,
	`owner_cursor_type` text,
	`owner_cursor_id` text,
	`owner_pages` integer DEFAULT 0 NOT NULL,
	`owner_done` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
