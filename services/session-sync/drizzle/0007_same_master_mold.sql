CREATE TABLE `pending_list_metadata` (
	`key` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`retry_at` integer NOT NULL
);
