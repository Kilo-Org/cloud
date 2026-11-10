CREATE TABLE `created_sessions` (
	`target` text PRIMARY KEY NOT NULL,
	`tenant_type` text NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_erasure` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL
);
