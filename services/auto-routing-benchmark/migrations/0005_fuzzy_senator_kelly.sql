PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_case_results` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`case_id` text NOT NULL,
	`route_key` text,
	`score` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`cost_usd` real,
	`error` text,
	`fallback_reason` text,
	`retried` integer,
	`exit_code` integer,
	`output_prefix` text,
	`event_count` integer,
	`last_event_types` text,
	`rep` integer DEFAULT 0 NOT NULL,
	`timed_out` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `variant`, `case_id`, `rep`)
);
--> statement-breakpoint
INSERT INTO `__new_case_results`("run_id", "model", "variant", "case_id", "route_key", "score", "latency_ms", "cost_usd", "error", "fallback_reason", "retried", "exit_code", "output_prefix", "event_count", "last_event_types", "rep", "timed_out") SELECT cr."run_id", cr."model", COALESCE(rm."reasoning_effort", ''), cr."case_id", cr."route_key", cr."score", cr."latency_ms", cr."cost_usd", cr."error", cr."fallback_reason", cr."retried", cr."exit_code", cr."output_prefix", cr."event_count", cr."last_event_types", cr."rep", cr."timed_out" FROM `case_results` cr LEFT JOIN `run_models` rm ON rm."run_id" = cr."run_id" AND rm."model" = cr."model";--> statement-breakpoint
DROP TABLE `case_results`;--> statement-breakpoint
ALTER TABLE `__new_case_results` RENAME TO `case_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_model_summaries` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`route_key` text NOT NULL,
	`accuracy` real NOT NULL,
	`avg_cost_usd` real,
	`avg_latency_ms` real NOT NULL,
	`p50_latency_ms` real,
	`cases` integer NOT NULL,
	`errors` integer NOT NULL,
	`p95_latency_ms` real,
	`timeouts` integer DEFAULT 0 NOT NULL,
	`carried` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `variant`, `route_key`)
);
--> statement-breakpoint
INSERT INTO `__new_model_summaries`("run_id", "model", "variant", "route_key", "accuracy", "avg_cost_usd", "avg_latency_ms", "p50_latency_ms", "cases", "errors", "p95_latency_ms", "timeouts", "carried") SELECT ms."run_id", ms."model", COALESCE(rm."reasoning_effort", ''), ms."route_key", ms."accuracy", ms."avg_cost_usd", ms."avg_latency_ms", ms."p50_latency_ms", ms."cases", ms."errors", ms."p95_latency_ms", ms."timeouts", ms."carried" FROM `model_summaries` ms LEFT JOIN `run_models` rm ON rm."run_id" = ms."run_id" AND rm."model" = ms."model";--> statement-breakpoint
DROP TABLE `model_summaries`;--> statement-breakpoint
ALTER TABLE `__new_model_summaries` RENAME TO `model_summaries`;--> statement-breakpoint
CREATE TABLE `__new_run_models` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`enqueued` integer NOT NULL,
	`reasoning_effort` text,
	PRIMARY KEY(`run_id`, `model`, `variant`)
);
--> statement-breakpoint
INSERT INTO `__new_run_models`("run_id", "model", "variant", "enqueued", "reasoning_effort") SELECT "run_id", "model", COALESCE("reasoning_effort", ''), "enqueued", "reasoning_effort" FROM `run_models`;--> statement-breakpoint
DROP TABLE `run_models`;--> statement-breakpoint
ALTER TABLE `__new_run_models` RENAME TO `run_models`;--> statement-breakpoint
ALTER TABLE `routing_table_candidates` ADD `variant` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `routing_table_candidates` SET `variant` = COALESCE(`reasoning_effort`, '') WHERE `reasoning_effort` IS NOT NULL;
