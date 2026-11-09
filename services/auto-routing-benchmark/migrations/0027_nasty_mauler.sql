ALTER TABLE `pending_decider_outputs` ADD `grading_token` text;--> statement-breakpoint
ALTER TABLE `pending_decider_outputs` ADD `grading_lease_until` integer DEFAULT 0 NOT NULL;