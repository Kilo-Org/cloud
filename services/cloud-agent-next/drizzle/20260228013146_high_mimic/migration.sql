CREATE TABLE IF NOT EXISTS `command_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`message_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_command_queue_session` ON `command_queue` (`session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_event_type` text NOT NULL,
	`payload` text NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_execution` ON `events` (`execution_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_type` ON `events` (`stream_event_type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_timestamp` ON `events` (`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_id_execution` ON `events` (`id`,`execution_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `execution_leases` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`lease_id` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`message_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_leases_expires` ON `execution_leases` (`lease_expires_at`);