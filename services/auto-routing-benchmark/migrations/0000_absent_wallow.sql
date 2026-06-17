CREATE TABLE `benchmark_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`min_accuracy` real NOT NULL,
	`switch_cost_factor` real NOT NULL,
	`max_concurrency` integer NOT NULL,
	`benchmark_user_id` text,
	`classifier_repetitions` integer DEFAULT 1 NOT NULL,
	`decider_repetitions` integer DEFAULT 1 NOT NULL,
	`classifier_max_p95_latency_ms` integer,
	`updated_at` text NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`min_accuracy` real NOT NULL,
	`switch_cost_factor` real NOT NULL,
	`max_concurrency` integer NOT NULL,
	`benchmark_user_id` text,
	`repetitions` integer DEFAULT 1 NOT NULL,
	`classifier_max_p95_latency_ms` integer,
	`engine_identity` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_benchmark_runs_one_running_per_kind` ON `benchmark_runs` (`kind`) WHERE "benchmark_runs"."status" = 'running';--> statement-breakpoint
CREATE TABLE `case_results` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
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
	PRIMARY KEY(`run_id`, `model`, `case_id`, `rep`)
);
--> statement-breakpoint
CREATE TABLE `config_classifier_models` (
	`model` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_decider_models` (
	`model` text PRIMARY KEY NOT NULL,
	`reasoning_effort` text
);
--> statement-breakpoint
CREATE TABLE `model_summaries` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
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
	PRIMARY KEY(`run_id`, `model`, `route_key`)
);
--> statement-breakpoint
CREATE TABLE `routing_table_candidates` (
	`run_id` text NOT NULL,
	`route_key` text NOT NULL,
	`rank` integer NOT NULL,
	`model` text NOT NULL,
	`accuracy` real NOT NULL,
	`avg_cost_usd` real NOT NULL,
	`meets_threshold` integer NOT NULL,
	`reasoning_effort` text,
	PRIMARY KEY(`run_id`, `route_key`, `rank`)
);
--> statement-breakpoint
CREATE TABLE `routing_tables` (
	`run_id` text PRIMARY KEY NOT NULL,
	`published_at` text NOT NULL,
	`generated_at` text NOT NULL,
	`min_accuracy` real NOT NULL,
	`switch_cost_factor` real NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_models` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`enqueued` integer NOT NULL,
	`reasoning_effort` text,
	PRIMARY KEY(`run_id`, `model`)
);
