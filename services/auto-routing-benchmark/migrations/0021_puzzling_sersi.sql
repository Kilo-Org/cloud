CREATE TABLE `scheduler_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`slots` integer,
	`model_concurrency` integer,
	`provider_concurrency` integer,
	`unknown_provider_concurrency` integer,
	`updated_at` text NOT NULL,
	`updated_by` text
);
