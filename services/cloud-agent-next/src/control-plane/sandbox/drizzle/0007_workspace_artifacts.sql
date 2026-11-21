CREATE TABLE `workspace_artifact_orphans` (
	`object_key` text PRIMARY KEY NOT NULL,
	`queued_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_artifacts` (
	`relative_path` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_type` text NOT NULL,
	`updated_at` integer NOT NULL
);
