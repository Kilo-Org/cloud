CREATE TABLE `scheduler_cooldowns` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`until` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `scheduler_dispatch_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_scheduler_chunks_lane` ON `scheduler_chunks` (`status`,`run_id`,`model`,`variant`,`rep`,`available_at`,`chunk`);--> statement-breakpoint
INSERT INTO `scheduler_dispatch_lock` (`id`, `token`, `lease_until`) VALUES (1, NULL, 0);