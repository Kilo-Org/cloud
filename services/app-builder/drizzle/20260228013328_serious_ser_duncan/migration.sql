CREATE TABLE IF NOT EXISTS `git_objects` (
	`path` text PRIMARY KEY NOT NULL,
	`parent_path` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`is_dir` integer DEFAULT 0 NOT NULL,
	`mtime` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_git_objects_parent` ON `git_objects` (`parent_path`,`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_git_objects_is_dir` ON `git_objects` (`is_dir`,`path`);