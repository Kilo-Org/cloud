CREATE TABLE `kv` (
	`scope` text NOT NULL,
	`k` text NOT NULL,
	`v` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `k`)
);
