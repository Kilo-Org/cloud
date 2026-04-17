CREATE TABLE `conversations` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`conversation_title` text,
	`sandbox_id` text NOT NULL,
	`last_message_id` text,
	`last_read_message_id` text,
	`joined_at` integer NOT NULL
);
