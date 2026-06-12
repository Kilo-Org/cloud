PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_case_results` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`case_id` text NOT NULL,
	`tier` text,
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
	PRIMARY KEY(`run_id`, `model`, `case_id`, `rep`)
);
--> statement-breakpoint
INSERT INTO `__new_case_results`("run_id", "model", "case_id", "tier", "score", "latency_ms", "cost_usd", "error", "fallback_reason", "retried", "exit_code", "output_prefix", "event_count", "last_event_types", "rep", "timed_out") SELECT "run_id", "model", "case_id", "tier", "score", "latency_ms", "cost_usd", "error", "fallback_reason", "retried", "exit_code", "output_prefix", "event_count", "last_event_types", "rep", "timed_out" FROM `case_results`;--> statement-breakpoint
DROP TABLE `case_results`;--> statement-breakpoint
ALTER TABLE `__new_case_results` RENAME TO `case_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `classifier_repetitions` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `decider_repetitions` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `classifier_max_p95_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `repetitions` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `classifier_max_p95_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `p95_latency_ms` real;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `timeouts` integer DEFAULT 0 NOT NULL;