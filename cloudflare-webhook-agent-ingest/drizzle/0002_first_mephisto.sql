ALTER TABLE `requests` ADD `trigger_source` text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_config` ADD `activation_mode` text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_config` ADD `cron_expression` text;--> statement-breakpoint
ALTER TABLE `trigger_config` ADD `cron_timezone` text DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE `trigger_config` ADD `last_scheduled_at` text;--> statement-breakpoint
ALTER TABLE `trigger_config` ADD `next_scheduled_at` text;