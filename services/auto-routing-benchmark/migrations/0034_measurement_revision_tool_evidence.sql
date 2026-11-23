ALTER TABLE `benchmark_runs` ADD `measurement_revision` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `case_results` ADD `tool_calls` integer;--> statement-breakpoint
ALTER TABLE `case_results` ADD `tool_names` text;--> statement-breakpoint
ALTER TABLE `case_results` ADD `step_count` integer;--> statement-breakpoint
ALTER TABLE `case_results` ADD `final_finish_reason` text;