CREATE TABLE `control_plane_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`intent` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`settled_at` integer,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_event_type` text NOT NULL,
	`payload` text NOT NULL,
	`timestamp` integer NOT NULL,
	`entity_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_entity_id_unique` ON `events` (`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_events_execution` ON `events` (`execution_id`);--> statement-breakpoint
CREATE INDEX `idx_events_type` ON `events` (`stream_event_type`);--> statement-breakpoint
CREATE INDEX `idx_events_timestamp` ON `events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_events_id_execution` ON `events` (`id`,`execution_id`);