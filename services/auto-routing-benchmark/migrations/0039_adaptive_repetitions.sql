ALTER TABLE `run_models` ADD `required_reps` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_models` ADD `repetition_state` text;--> statement-breakpoint
ALTER TABLE `run_models` ADD `repetition_routes` text;