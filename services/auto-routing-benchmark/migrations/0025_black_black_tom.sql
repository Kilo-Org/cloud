CREATE TABLE `benchmark_subscriptions` (
	`router` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`revision` text NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`router`, `owner_type`, `owner_id`)
);
--> statement-breakpoint
ALTER TABLE `benchmark_profiles` ADD `invalidated_at` text;