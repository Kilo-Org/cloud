CREATE TABLE `config_auto_decider_exclusions` (
	`model` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_auto_decider_models` (
	`model` text PRIMARY KEY NOT NULL,
	`reasoning_effort` text,
	`avg_attempt_cost_usd` real NOT NULL,
	`synced_at` text NOT NULL
);
