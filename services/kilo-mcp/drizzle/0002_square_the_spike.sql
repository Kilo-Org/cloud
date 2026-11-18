CREATE TABLE `oauth_pending_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_request` text NOT NULL,
	`device_auth_code` text NOT NULL,
	`status` text NOT NULL,
	`kilo_user_id` text,
	`organization_id` text,
	`kilo_token` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_pending_authorizations_device_auth_code` ON `oauth_pending_authorizations` (`device_auth_code`);