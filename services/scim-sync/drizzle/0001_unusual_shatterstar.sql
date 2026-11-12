CREATE TABLE `directory_conflicts` (
	`directory_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`first_conflict_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `parked_activations` (
	`directory_id` text PRIMARY KEY NOT NULL,
	`parked_at` integer NOT NULL
);
