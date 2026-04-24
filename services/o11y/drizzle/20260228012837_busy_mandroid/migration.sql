CREATE TABLE IF NOT EXISTS `alert_config` (
	`model` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`error_rate_slo` real NOT NULL,
	`min_requests_per_window` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ttfb_alert_config` (
	`model` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`ttfb_threshold_ms` integer NOT NULL,
	`ttfb_slo` real NOT NULL,
	`min_requests_per_window` integer NOT NULL,
	`updated_at` text NOT NULL
);
