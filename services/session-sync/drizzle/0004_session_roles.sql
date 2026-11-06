CREATE TABLE `session_roles` (
	`principal_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `session_roles` (`principal_id`, `role`)
SELECT `creator_id`, 'owner' FROM `session` WHERE `key` = 1;
