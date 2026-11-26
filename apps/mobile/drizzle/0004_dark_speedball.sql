ALTER TABLE `chats` ADD `server_session_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_source_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_state` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_acknowledged` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_ack_batch` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_ack_digest` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_max_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_acked_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_outbox` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `sync_message_map` text;--> statement-breakpoint
CREATE UNIQUE INDEX `chats_server_session_id` ON `chats` (`server_session_id`);