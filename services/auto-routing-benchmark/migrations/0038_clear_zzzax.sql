CREATE TABLE `benchmark_case_payers` (
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`generation` integer NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`engine_identity`, `model`, `variant`, `rep`, `case_id`, `generation`, `owner_type`, `owner_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `IX_benchmark_case_payers_owner` ON `benchmark_case_payers` (`owner_type`,`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `IX_benchmark_case_payers_request` ON `benchmark_case_payers` (`request_id`,`status`);--> statement-breakpoint
CREATE TABLE `benchmark_case_runs` (
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`executor_run_id` text,
	`executor_token` text,
	`platform_covered` integer DEFAULT false NOT NULL,
	`result_usable` integer DEFAULT false NOT NULL,
	`cost_microdollars` integer,
	`settlement_id` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`settled_at` text,
	PRIMARY KEY(`engine_identity`, `model`, `variant`, `rep`, `case_id`)
);
--> statement-breakpoint
CREATE INDEX `IX_benchmark_case_runs_executor` ON `benchmark_case_runs` (`executor_run_id`);--> statement-breakpoint
CREATE INDEX `IX_benchmark_case_runs_status` ON `benchmark_case_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `benchmark_cutover` (
	`id` integer PRIMARY KEY NOT NULL,
	`cutover_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paid_attempt_usage` (
	`usage_id` text PRIMARY KEY NOT NULL,
	`model_request_id` text NOT NULL,
	`request_id` text NOT NULL,
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`generation` integer NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`microdollars` integer NOT NULL,
	`platform_covered` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_paid_attempt_usage_model_request` ON `paid_attempt_usage` (`model_request_id`);--> statement-breakpoint
CREATE INDEX `IX_paid_attempt_usage_request` ON `paid_attempt_usage` (`request_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `IX_paid_attempt_usage_covered_case` ON `paid_attempt_usage` (`engine_identity`,`model`,`variant`,`rep`,`case_id`) WHERE "paid_attempt_usage"."platform_covered" = 1;--> statement-breakpoint
CREATE INDEX `IX_paid_attempt_usage_case` ON `paid_attempt_usage` (`request_id`,`engine_identity`,`model`,`variant`,`rep`,`case_id`,`platform_covered`);--> statement-breakpoint
CREATE TABLE `paid_benchmark_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`router` text DEFAULT 'efficient' NOT NULL,
	`router_id` text NOT NULL,
	`pool_version` text NOT NULL,
	`engine_identity` text NOT NULL,
	`context` text NOT NULL,
	`plan` text NOT NULL,
	`estimate_microdollars` integer NOT NULL,
	`maximum_microdollars` integer NOT NULL,
	`plan_cases` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`started_request_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_quotes_owner` ON `paid_benchmark_quotes` (`owner_type`,`owner_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `paid_benchmark_request_cases` (
	`request_id` text NOT NULL,
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`covered_by_kilo` integer DEFAULT false NOT NULL,
	`charged_microdollars` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`request_id`, `engine_identity`, `model`, `variant`, `rep`, `case_id`),
	FOREIGN KEY (`request_id`) REFERENCES `paid_benchmark_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_request_cases_status` ON `paid_benchmark_request_cases` (`request_id`,`status`);--> statement-breakpoint
CREATE TABLE `paid_benchmark_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`router` text DEFAULT 'efficient' NOT NULL,
	`router_id` text NOT NULL,
	`pool_version` text NOT NULL,
	`engine_identity` text NOT NULL,
	`status` text NOT NULL,
	`quote_id` text NOT NULL,
	`estimate_microdollars` integer NOT NULL,
	`maximum_microdollars` integer NOT NULL,
	`charged_microdollars` integer DEFAULT 0 NOT NULL,
	`plan_cases` integer DEFAULT 0 NOT NULL,
	`staged_cases` integer DEFAULT 0 NOT NULL,
	`pause_reason` text,
	`actor_user_id` text NOT NULL,
	`context` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activated_at` text,
	`paused_at` text,
	`completed_at` text,
	`failure_reason` text,
	`failure_retryable` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_requests_owner` ON `paid_benchmark_requests` (`owner_type`,`owner_id`,`router_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_requests_status` ON `paid_benchmark_requests` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `UQ_paid_benchmark_requests_live_router` ON `paid_benchmark_requests` (`router_id`) WHERE "paid_benchmark_requests"."status" IN ('preparing', 'active');--> statement-breakpoint
CREATE TABLE `paid_benchmark_billing_outbox` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`request_id` text NOT NULL,
	`case_engine_identity` text,
	`case_model` text,
	`case_variant` text,
	`case_rep` integer,
	`case_id` text,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`amount_microdollars` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paid_benchmark_billing_outbox_id_unique` ON `paid_benchmark_billing_outbox` (`id`);--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_billing_outbox_pending` ON `paid_benchmark_billing_outbox` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `paid_benchmark_cancellations` (
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`generation` integer NOT NULL,
	`executor_run_id` text NOT NULL,
	`executor_token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	`last_error` text,
	PRIMARY KEY(`engine_identity`, `model`, `variant`, `rep`, `case_id`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `IX_paid_benchmark_cancellations_pending` ON `paid_benchmark_cancellations` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `paid_model_request_attempts` (
	`model_request_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`pool_request_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`model_request_id`, `assignment_id`),
	FOREIGN KEY (`model_request_id`) REFERENCES `paid_model_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `IX_paid_model_request_attempts_pool` ON `paid_model_request_attempts` (`pool_request_id`,`status`);--> statement-breakpoint
CREATE TABLE `paid_model_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`engine_identity` text NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`rep` integer NOT NULL,
	`case_id` text NOT NULL,
	`generation` integer NOT NULL,
	`pool_request_id` text,
	`state` text DEFAULT 'selecting' NOT NULL,
	`assignment_id` text,
	`api` text,
	`executor_user_id` text,
	`project_id` text,
	`usage_id` text,
	`platform_organization_id` text,
	`owner_type` text,
	`owner_id` text,
	`platform_covered` integer DEFAULT false NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_paid_model_requests_case` ON `paid_model_requests` (`engine_identity`,`model`,`variant`,`rep`,`case_id`,`generation`);--> statement-breakpoint
CREATE INDEX `IX_paid_model_requests_state` ON `paid_model_requests` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `profile_attempt_history` (
	`router` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`run_id` text NOT NULL,
	`repetitions` integer NOT NULL,
	`outcome` text NOT NULL,
	`failure_class` text,
	`failure_reason` text,
	`attempted_at` text NOT NULL,
	PRIMARY KEY(`router`, `model`, `variant`, `engine_identity`, `run_id`)
);
--> statement-breakpoint
CREATE INDEX `IDX_profile_attempt_history_pair_time` ON `profile_attempt_history` (`router`,`model`,`variant`,`engine_identity`,`attempted_at`);--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `admission_marker` text;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `desired_pairs` text;