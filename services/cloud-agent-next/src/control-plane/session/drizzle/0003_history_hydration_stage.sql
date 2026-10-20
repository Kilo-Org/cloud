CREATE TABLE `history_import` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`timestamp` integer NOT NULL
);
