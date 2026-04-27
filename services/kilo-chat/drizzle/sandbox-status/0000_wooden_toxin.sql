CREATE TABLE `bot_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`online` integer NOT NULL,
	`at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "bot_status_singleton_check" CHECK("bot_status"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `conversation_status` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`context_tokens` integer NOT NULL,
	`context_window` integer NOT NULL,
	`model` text,
	`provider` text,
	`at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
