ALTER TABLE `events` ADD COLUMN `entity_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_entity_id_unique` ON `events` (`entity_id`);
