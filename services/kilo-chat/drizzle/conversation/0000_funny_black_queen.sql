CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	CONSTRAINT "members_kind_check" CHECK("members"."kind" IN ('user', 'bot'))
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`content` text NOT NULL,
	`in_reply_to_message_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer,
	`client_updated_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	`delivery_failed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`in_reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_deleted_check" CHECK("messages"."deleted" IN (0, 1)),
	CONSTRAINT "messages_version_check" CHECK("messages"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `messages_sender_id_idx` ON `messages` (`sender_id`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_id` text NOT NULL,
	`member_id` text NOT NULL,
	`emoji` text NOT NULL,
	`id` text NOT NULL,
	`added_at` integer NOT NULL,
	`deleted_at` integer,
	`removed_id` text,
	PRIMARY KEY(`message_id`, `member_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reactions_live_state_check" CHECK(("reactions"."deleted_at" IS NULL AND "reactions"."removed_id" IS NULL)
          OR ("reactions"."deleted_at" IS NOT NULL AND "reactions"."removed_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `reactions_by_id` ON `reactions` (`id`);--> statement-breakpoint
CREATE INDEX `reactions_by_removed_id` ON `reactions` (`removed_id`);--> statement-breakpoint
CREATE INDEX `reactions_by_message_live` ON `reactions` (`message_id`) WHERE "reactions"."deleted_at" IS NULL;