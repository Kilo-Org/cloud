CREATE TABLE `lease_replica_sweep` (
	`replica` text PRIMARY KEY NOT NULL,
	`next_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL
);
