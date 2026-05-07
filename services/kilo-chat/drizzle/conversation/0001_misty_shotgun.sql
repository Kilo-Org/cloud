CREATE TABLE `bot_message_notifications` (
	`message_id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`notify_after` integer NOT NULL,
	`notified_at` integer,
	`notified_reason` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bot_message_notifications_notified_reason_check" CHECK("bot_message_notifications"."notified_reason" IS NULL
          OR "bot_message_notifications"."notified_reason" IN ('length', 'typing_stop', 'timeout'))
);
--> statement-breakpoint
CREATE INDEX `bot_message_notifications_pending_by_notify_after_idx` ON `bot_message_notifications` (`notify_after`) WHERE "bot_message_notifications"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX `bot_message_notifications_pending_by_bot_idx` ON `bot_message_notifications` (`bot_id`,`created_at`) WHERE "bot_message_notifications"."notified_at" IS NULL;