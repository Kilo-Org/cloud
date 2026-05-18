CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`uploader_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`filename` text NOT NULL,
	`status` text NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_status_check" CHECK("attachments"."status" IN ('pending', 'linked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `attachments_status_created` ON `attachments` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `attachments_message_id` ON `attachments` (`message_id`);