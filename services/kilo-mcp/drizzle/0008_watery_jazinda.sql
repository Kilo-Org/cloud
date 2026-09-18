ALTER TABLE `mcp_admin_authenticators` ADD `failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_admin_authenticators` ADD `locked_until` text;