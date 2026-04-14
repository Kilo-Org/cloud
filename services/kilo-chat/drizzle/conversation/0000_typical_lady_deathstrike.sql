CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`content` text NOT NULL,
	`in_reply_to_message_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL
);
