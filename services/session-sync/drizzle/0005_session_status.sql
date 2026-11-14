CREATE TABLE `session_status` (
	`key` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL
);
