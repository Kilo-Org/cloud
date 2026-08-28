CREATE TABLE `projection_work` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`acknowledged_at` text
);
--> statement-breakpoint
CREATE INDEX `due_projections` ON `projection_work` (`acknowledged_at`,`due_at`,`id`);