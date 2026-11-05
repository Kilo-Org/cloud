CREATE TABLE `presence_advertisements` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`advertisement` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presence_command_rates` (
	`key` text PRIMARY KEY NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presence_command_routes` (
	`command_id` text PRIMARY KEY NOT NULL,
	`controller_connection_id` text,
	`runner_connection_id` text NOT NULL,
	`tenant_type` text NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `presence_command_expiry_idx` ON `presence_command_routes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `presence_command_runner_idx` ON `presence_command_routes` (`runner_connection_id`);--> statement-breakpoint
CREATE INDEX `presence_command_controller_idx` ON `presence_command_routes` (`controller_connection_id`);