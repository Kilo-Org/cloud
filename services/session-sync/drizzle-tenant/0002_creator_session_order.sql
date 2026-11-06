ALTER TABLE `created_sessions` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `created_sessions_newest` ON `created_sessions` (`created_at`,`target`);