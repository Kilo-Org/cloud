ALTER TABLE `case_results` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `case_results` ADD `cached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `case_results` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `case_results` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `avg_input_tokens` real;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `avg_cached_input_tokens` real;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `avg_output_tokens` real;--> statement-breakpoint
ALTER TABLE `model_summaries` ADD `avg_reasoning_tokens` real;