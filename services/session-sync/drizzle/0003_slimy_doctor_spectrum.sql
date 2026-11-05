ALTER TABLE `session` ADD `last_write_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `session` SET `last_write_at` = `updated_at`;