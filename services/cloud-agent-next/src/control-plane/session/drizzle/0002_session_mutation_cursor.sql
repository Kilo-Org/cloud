ALTER TABLE `events` ADD `mutation_cursor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `events` SET `mutation_cursor` = `id`;
--> statement-breakpoint
CREATE INDEX `idx_events_mutation_cursor` ON `events` (`mutation_cursor`);
--> statement-breakpoint
CREATE TABLE `event_mutation_cursor` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `event_mutation_cursor` (`id`, `cursor`) SELECT 1, coalesce(max(`mutation_cursor`), 0) FROM `events`;
