CREATE TABLE `cloud_wakeups` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`message_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`prompt` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`failure` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_wakeups_call_id_unique` ON `cloud_wakeups` (`call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_wakeups_message_id_unique` ON `cloud_wakeups` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_wakeups_one_pending` ON `cloud_wakeups` (`state`) WHERE "cloud_wakeups"."state" = 'pending';