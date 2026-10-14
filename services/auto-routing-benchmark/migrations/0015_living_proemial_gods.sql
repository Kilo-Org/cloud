DROP INDEX `UQ_benchmark_runs_one_running_per_kind_purpose`;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `router` text DEFAULT 'efficient' NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `accuracy_noise_band` real DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `frontier_min_accuracy_delta` real DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_benchmark_runs_one_running_per_router_kind_purpose` ON `benchmark_runs` (`router`,`kind`,`purpose`) WHERE "benchmark_runs"."status" = 'running';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_benchmark_profiles` (
	`model` text NOT NULL,
	`router` text DEFAULT 'efficient' NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`failure_reason` text,
	`requested_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`platform_requested` integer DEFAULT false NOT NULL,
	`user_requested` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`router`, `model`, `variant`, `engine_identity`, `repetitions`)
);
--> statement-breakpoint
INSERT INTO `__new_benchmark_profiles`("model", "router", "variant", "engine_identity", "repetitions", "status", "run_id", "failure_reason", "requested_at", "updated_at", "completed_at", "platform_requested", "user_requested") SELECT "model", "router", "variant", "engine_identity", "repetitions", "status", "run_id", "failure_reason", "requested_at", "updated_at", "completed_at", "platform_requested", "user_requested" FROM `benchmark_profiles`;--> statement-breakpoint
DROP TABLE `benchmark_profiles`;--> statement-breakpoint
ALTER TABLE `__new_benchmark_profiles` RENAME TO `benchmark_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_config_auto_decider_exclusions` (
	`router` text DEFAULT 'efficient' NOT NULL,
	`model` text NOT NULL,
	PRIMARY KEY(`router`, `model`)
);
--> statement-breakpoint
INSERT INTO `__new_config_auto_decider_exclusions`("router", "model") SELECT "router", "model" FROM `config_auto_decider_exclusions`;--> statement-breakpoint
DROP TABLE `config_auto_decider_exclusions`;--> statement-breakpoint
ALTER TABLE `__new_config_auto_decider_exclusions` RENAME TO `config_auto_decider_exclusions`;--> statement-breakpoint
CREATE TABLE `__new_config_auto_decider_models` (
	`router` text DEFAULT 'efficient' NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text,
	`avg_attempt_cost_usd` real NOT NULL,
	`synced_at` text NOT NULL,
	PRIMARY KEY(`router`, `model`)
);
--> statement-breakpoint
INSERT INTO `__new_config_auto_decider_models`("router", "model", "reasoning_effort", "avg_attempt_cost_usd", "synced_at") SELECT "router", "model", "reasoning_effort", "avg_attempt_cost_usd", "synced_at" FROM `config_auto_decider_models`;--> statement-breakpoint
DROP TABLE `config_auto_decider_models`;--> statement-breakpoint
ALTER TABLE `__new_config_auto_decider_models` RENAME TO `config_auto_decider_models`;--> statement-breakpoint
CREATE TABLE `__new_config_classifier_models` (
	`router` text DEFAULT 'efficient' NOT NULL,
	`model` text NOT NULL,
	PRIMARY KEY(`router`, `model`)
);
--> statement-breakpoint
INSERT INTO `__new_config_classifier_models`("router", "model") SELECT "router", "model" FROM `config_classifier_models`;--> statement-breakpoint
DROP TABLE `config_classifier_models`;--> statement-breakpoint
ALTER TABLE `__new_config_classifier_models` RENAME TO `config_classifier_models`;--> statement-breakpoint
CREATE TABLE `__new_config_decider_models` (
	`router` text DEFAULT 'efficient' NOT NULL,
	`model` text NOT NULL,
	`variant` text,
	`reasoning_effort` text,
	PRIMARY KEY(`router`, `model`)
);
--> statement-breakpoint
INSERT INTO `__new_config_decider_models`("router", "model", "variant", "reasoning_effort") SELECT "router", "model", "variant", "reasoning_effort" FROM `config_decider_models`;--> statement-breakpoint
DROP TABLE `config_decider_models`;--> statement-breakpoint
ALTER TABLE `__new_config_decider_models` RENAME TO `config_decider_models`;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `router` text DEFAULT 'efficient' NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `accuracy_noise_band` real DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `frontier_min_accuracy_delta` real DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_config_router_unique` ON `benchmark_config` (`router`);--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `router` text DEFAULT 'efficient' NOT NULL;