CREATE TABLE `instances` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`do_key` text NOT NULL,
	`assigned_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`destroyed_at` text
);
