CREATE TABLE `chats` (
	`session_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chats_scope_updated_at` ON `chats` (`scope`,`updated_at`);