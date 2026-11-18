CREATE TABLE `allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`allocation_id` text,
	`connection_id` text,
	`provider_ref` text,
	`wrapper_id` text,
	`last_frame_at` integer,
	`last_activity_at` integer,
	`create_deadline_at` integer,
	`first_connect_deadline_at` integer,
	`stop_attempt` integer NOT NULL,
	`stop_pending` integer NOT NULL,
	`stop_at` integer,
	`unconfirmed_provider_ref` text,
	`provider_pin` text
);
--> statement-breakpoint
CREATE TABLE `routes` (
	`session_id` text PRIMARY KEY NOT NULL,
	`spec` text NOT NULL,
	`grant` text,
	`credential_source` text,
	`state` text NOT NULL,
	`attempt_id` text NOT NULL,
	`attempt_deadline_at` integer,
	`reason` text,
	`updated_at` integer NOT NULL
);
