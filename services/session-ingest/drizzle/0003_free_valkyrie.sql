ALTER TABLE `sessions` ADD `organization_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `authorization_expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_organization_id_idx` ON `sessions` (`organization_id`);