CREATE TABLE `conversations` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`conversation_title` text,
	`sandbox_id` text NOT NULL,
	`last_activity_at` integer,
	`last_read_at` integer,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_sandbox_id_idx` ON `conversations` (`sandbox_id`);