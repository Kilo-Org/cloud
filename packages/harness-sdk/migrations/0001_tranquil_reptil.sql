CREATE TABLE `parts` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`media` text,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parts_session_id_id` ON `parts` (`session_id`,`id`);--> statement-breakpoint
ALTER TABLE `turns` DROP COLUMN `content`;