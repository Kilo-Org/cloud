CREATE TABLE `agent_notification_dispatch` (
	`identity` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
