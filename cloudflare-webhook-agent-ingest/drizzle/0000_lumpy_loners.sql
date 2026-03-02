CREATE TABLE IF NOT EXISTS `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`query_string` text,
	`headers` text NOT NULL,
	`body` text NOT NULL,
	`content_type` text,
	`source_ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` text,
	`completed_at` text,
	`process_status` text DEFAULT 'captured' NOT NULL,
	`cloud_agent_session_id` text,
	`error_message` text,
	CONSTRAINT "process_status_check" CHECK(process_status in ('captured', 'inprogress', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_requests_timestamp` ON `requests` ("timestamp" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_requests_status` ON `requests` (`process_status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_requests_session` ON `requests` (`cloud_agent_session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trigger_config` (
	`trigger_id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`user_id` text,
	`org_id` text,
	`created_at` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`github_repo` text NOT NULL,
	`mode` text NOT NULL,
	`model` text NOT NULL,
	`prompt_template` text NOT NULL,
	`profile_id` text NOT NULL,
	`auto_commit` integer,
	`condense_on_complete` integer,
	`webhook_auth_header` text,
	`webhook_auth_secret_hash` text
);
