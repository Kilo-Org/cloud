DROP INDEX `created_sessions_newest`;--> statement-breakpoint
ALTER TABLE `created_sessions` ADD `title` text;--> statement-breakpoint
ALTER TABLE `created_sessions` ADD `client` text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE `created_sessions` ADD `directory` text;--> statement-breakpoint
ALTER TABLE `created_sessions` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `created_sessions` ADD `archived` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `created_sessions_updated` ON `created_sessions` (`updated_at`,`target`);