CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`generation` integer NOT NULL,
	`intent` text NOT NULL,
	`outcome` text,
	`provider_reference` text,
	FOREIGN KEY (`tool_call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_generation` ON `attempts` (`tool_call_id`,`generation`);--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`position` integer NOT NULL,
	`input_digest` text NOT NULL,
	`data` text NOT NULL,
	`policy` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `call_order` ON `calls` (`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step` integer NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`definition_versions` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoint_step` ON `checkpoints` (`run_id`,`step`);--> statement-breakpoint
CREATE TABLE `client_actions` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`reply` text NOT NULL,
	`sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`context` text NOT NULL,
	`permission_mode` text DEFAULT 'ask' NOT NULL,
	`permission_revision` integer DEFAULT 0 NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`compacted_through` integer DEFAULT 0 NOT NULL,
	`active_run_id` text,
	`legacy_cursor` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "one_conversation" CHECK("conversation"."singleton" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_id_unique` ON `conversation` (`id`);--> statement-breakpoint
CREATE TABLE `events` (
	`sequence` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`generation` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`tool_call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grant_generation` ON `grants` (`tool_call_id`,`generation`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`resolved` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unresolved_interactions` ON `interactions` (`resolved`,`sequence`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_sequence_unique` ON `messages` (`sequence`);--> statement-breakpoint
CREATE INDEX `message_history` ON `messages` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`active_slot` integer,
	CONSTRAINT "active_run_slot" CHECK(("runs"."status" IN ('running', 'waiting', 'stopping') AND "runs"."active_slot" IS 1) OR ("runs"."status" NOT IN ('running', 'waiting', 'stopping') AND "runs"."active_slot" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_position_unique` ON `runs` (`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_active_slot_unique` ON `runs` (`active_slot`);--> statement-breakpoint
CREATE INDEX `run_queue` ON `runs` (`status`,`position`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`cursor` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "one_snapshot" CHECK("snapshots"."singleton" = 1)
);
