CREATE TABLE `mcp_approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kilo_user_id` text NOT NULL,
	`organization_id` text,
	`client_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_json` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_approval_requests_dedupe` ON `mcp_approval_requests` (`kilo_user_id`,`path`,`kind`,`input_hash`,`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_approval_requests_queue` ON `mcp_approval_requests` (`kilo_user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `mcp_approval_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kilo_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
