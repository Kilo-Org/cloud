CREATE TABLE `relay_commands` (
	`ordinal` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_id` text NOT NULL,
	`from` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`bytes` integer NOT NULL,
	`live_only` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`delivered_at` integer,
	`status` text NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_commands_id_idx` ON `relay_commands` (`command_id`);--> statement-breakpoint
CREATE INDEX `relay_commands_expiry_idx` ON `relay_commands` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_rates` (
	`key` text PRIMARY KEY NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`purged` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_watches` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`session_id` text NOT NULL
);
