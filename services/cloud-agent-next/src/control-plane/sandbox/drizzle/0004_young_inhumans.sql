CREATE TABLE `workspace_disk_allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_disk_snapshots` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
