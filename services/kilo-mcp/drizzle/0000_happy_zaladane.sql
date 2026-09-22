CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`redirect_uris` text NOT NULL,
	`client_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`state` text,
	`device_auth_code` text NOT NULL,
	`status` text NOT NULL,
	`kilo_user_id` text,
	`organization_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_codes_device_auth_code` ON `oauth_codes` (`device_auth_code`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`kilo_user_id` text NOT NULL,
	`organization_id` text,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_refresh_tokens_hash` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `oauth_revoked_jtis` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text NOT NULL
);
