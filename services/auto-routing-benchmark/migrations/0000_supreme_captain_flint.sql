CREATE TABLE `benchmark_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`min_accuracy` real NOT NULL,
	`max_concurrency` integer NOT NULL,
	`benchmark_user_id` text,
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
	`max_concurrency` integer NOT NULL,
	`benchmark_user_id` text
);
--> statement-breakpoint
CREATE TABLE `case_results` (
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
	PRIMARY KEY(`run_id`, `model`, `case_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_case_results_run` ON `case_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `config_classifier_models` (
	`model` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_decider_models` (
	`model` text PRIMARY KEY NOT NULL,
	`reasoning_effort` text,
	`supports_chat_completions` integer NOT NULL,
	`supports_messages` integer NOT NULL,
	`supports_responses` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_summaries` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`tier` text NOT NULL,
	`accuracy` real NOT NULL,
	`avg_cost_usd` real,
	`avg_latency_ms` real NOT NULL,
	`p50_latency_ms` real,
	`cases` integer NOT NULL,
	`errors` integer NOT NULL,
	`carried` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `tier`)
);
--> statement-breakpoint
CREATE TABLE `routing_table_candidates` (
	`run_id` text NOT NULL,
	`tier` text NOT NULL,
	`rank` integer NOT NULL,
	`model` text NOT NULL,
	`accuracy` real NOT NULL,
	`avg_cost_usd` real,
	`meets_threshold` integer NOT NULL,
	`reasoning_effort` text,
	`supports_chat_completions` integer NOT NULL,
	`supports_messages` integer NOT NULL,
	`supports_responses` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tier`, `rank`)
);
--> statement-breakpoint
CREATE TABLE `routing_tables` (
	`run_id` text PRIMARY KEY NOT NULL,
	`published_at` text NOT NULL,
	`generated_at` text NOT NULL,
	`min_accuracy` real NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_models` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`enqueued` integer NOT NULL,
	`reasoning_effort` text,
	`supports_chat_completions` integer NOT NULL,
	`supports_messages` integer NOT NULL,
	`supports_responses` integer NOT NULL,
	PRIMARY KEY(`run_id`, `model`)
);
