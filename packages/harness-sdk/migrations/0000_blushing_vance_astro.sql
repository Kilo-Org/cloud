CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`system` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`max_tokens` integer
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `turns_session_id_id` ON `turns` (`session_id`,`id`);