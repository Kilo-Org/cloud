CREATE TABLE IF NOT EXISTS `attributions_metadata` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text,
	`branch` text NOT NULL,
	`file_path` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text,
	`created_at` text DEFAULT current_timestamp NOT NULL,
	CONSTRAINT "status_check" CHECK(status in ('accepted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_file_path` ON `attributions_metadata` (`file_path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_created_at` ON `attributions_metadata` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_org` ON `attributions_metadata` (`user_id`,`organization_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `lines_added` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attributions_metadata_id` integer NOT NULL,
	`line_number` integer NOT NULL,
	`line_hash` text NOT NULL,
	FOREIGN KEY (`attributions_metadata_id`) REFERENCES `attributions_metadata`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attribution_added` ON `lines_added` (`attributions_metadata_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hash_added` ON `lines_added` (`line_hash`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `lines_removed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attributions_metadata_id` integer NOT NULL,
	`line_number` integer NOT NULL,
	`line_hash` text NOT NULL,
	FOREIGN KEY (`attributions_metadata_id`) REFERENCES `attributions_metadata`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attribution_removed` ON `lines_removed` (`attributions_metadata_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hash_removed` ON `lines_removed` (`line_hash`);