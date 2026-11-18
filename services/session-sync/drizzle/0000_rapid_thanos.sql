CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`attempt` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text NOT NULL,
	`deadline` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`value` text,
	`blob_hash` text,
	`blob_bytes` integer,
	`inline_bytes` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`after` integer NOT NULL,
	`through` integer NOT NULL,
	`revision` integer NOT NULL,
	`changes` integer NOT NULL,
	`committed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `receipts_through_idx` ON `receipts` (`through`);--> statement-breakpoint
CREATE TABLE `session` (
	`key` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tenant_type` text NOT NULL,
	`tenant_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`source_id` text NOT NULL,
	`position` integer NOT NULL,
	`revision` integer NOT NULL,
	`batches` integer NOT NULL,
	`entity_count` integer NOT NULL,
	`inline_bytes` integer NOT NULL,
	`blob_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
