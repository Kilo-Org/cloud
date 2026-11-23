CREATE TABLE `list_metadata` (
	`key` integer PRIMARY KEY NOT NULL,
	`owed` text,
	`pushed` text,
	`retry_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
