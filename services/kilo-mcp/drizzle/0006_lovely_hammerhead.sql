CREATE TABLE `mcp_admin_authenticators` (
	`kilo_user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`verified_at` text,
	`last_used_step` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_protected_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kilo_user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`input_json` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_protected_requests_session` ON `mcp_protected_requests` (`session_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_protected_requests_owner` ON `mcp_protected_requests` (`kilo_user_id`,`status`,`expires_at`);