CREATE TABLE `profile_remeasures` (
	`router` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`engine_identity` text NOT NULL,
	`repetitions` integer NOT NULL,
	`run_id` text,
	`requested_at` text NOT NULL,
	`claimed_at` text,
	PRIMARY KEY(`router`, `model`, `variant`, `engine_identity`, `repetitions`)
);
--> statement-breakpoint
CREATE INDEX `IDX_profile_remeasures_run` ON `profile_remeasures` (`run_id`);--> statement-breakpoint
ALTER TABLE `case_results` ADD `prompt_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `client_case_results` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_decider_outputs` ADD `prompt_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler_executions` ADD `prompt_revision` integer DEFAULT 1 NOT NULL;