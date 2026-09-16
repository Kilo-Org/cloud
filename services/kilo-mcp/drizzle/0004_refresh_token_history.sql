CREATE TABLE `oauth_refresh_token_history` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`current` integer NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_token_grant` ON `oauth_refresh_token_history` (`user_id`,`grant_id`);