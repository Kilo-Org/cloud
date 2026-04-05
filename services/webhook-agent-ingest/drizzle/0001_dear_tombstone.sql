PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_trigger_config` (
	`trigger_id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`user_id` text,
	`org_id` text,
	`created_at` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`target_type` text DEFAULT 'cloud_agent' NOT NULL,
	`kiloclaw_instance_id` text,
	`github_repo` text,
	`mode` text,
	`model` text,
	`prompt_template` text NOT NULL,
	`profile_id` text,
	`auto_commit` integer,
	`condense_on_complete` integer,
	`webhook_auth_header` text,
	`webhook_auth_secret_hash` text
);
--> statement-breakpoint
INSERT INTO `__new_trigger_config`("trigger_id", "namespace", "user_id", "org_id", "created_at", "is_active", "target_type", "kiloclaw_instance_id", "github_repo", "mode", "model", "prompt_template", "profile_id", "auto_commit", "condense_on_complete", "webhook_auth_header", "webhook_auth_secret_hash") SELECT "trigger_id", "namespace", "user_id", "org_id", "created_at", "is_active", 'cloud_agent', NULL, "github_repo", "mode", "model", "prompt_template", "profile_id", "auto_commit", "condense_on_complete", "webhook_auth_header", "webhook_auth_secret_hash" FROM `trigger_config`;--> statement-breakpoint
DROP TABLE `trigger_config`;--> statement-breakpoint
ALTER TABLE `__new_trigger_config` RENAME TO `trigger_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
