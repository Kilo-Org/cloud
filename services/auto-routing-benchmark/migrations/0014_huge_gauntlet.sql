CREATE TABLE `pending_decider_outputs` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`case_id` text NOT NULL,
	`rep` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `variant`, `case_id`, `rep`),
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
