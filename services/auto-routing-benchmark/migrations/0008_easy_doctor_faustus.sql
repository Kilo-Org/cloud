CREATE TABLE `run_lane_failures` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`rep` integer DEFAULT 0 NOT NULL,
	`chunk` integer DEFAULT 0 NOT NULL,
	`shard` integer DEFAULT 0 NOT NULL,
	`failed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `model`, `variant`, `rep`, `chunk`, `shard`)
);
