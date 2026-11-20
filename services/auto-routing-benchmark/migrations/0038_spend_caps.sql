CREATE TABLE `benchmark_budget_holds` (
	`router` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`owner_type` text DEFAULT '' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`scope` text NOT NULL,
	`estimate_usd` real NOT NULL,
	`remaining_usd` real NOT NULL,
	`held_at` text NOT NULL,
	PRIMARY KEY(`router`, `model`, `variant`, `engine_identity`, `repetitions`)
);
--> statement-breakpoint
CREATE TABLE `benchmark_spend_ledger` (
	`day` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`spent_usd` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `owner_type`, `owner_id`)
);
--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `user_queue_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `spend_estimate_usd` real;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `spend_owner_type` text;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `spend_owner_id` text;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `spend_pause_scope` text;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `spent_usd` real DEFAULT 0 NOT NULL;