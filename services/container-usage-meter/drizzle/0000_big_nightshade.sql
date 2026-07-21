CREATE TABLE `pending_usage_mutations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotency_key` text NOT NULL,
	`operation` text NOT NULL,
	`interval_id` text NOT NULL,
	`context_fingerprint` text,
	`payload` text NOT NULL,
	`received_at_ms` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_usage_mutations_idempotency_key_unique` ON `pending_usage_mutations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pending_usage_mutations_drain_idx` ON `pending_usage_mutations` (`next_attempt_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `pending_usage_mutations_received_idx` ON `pending_usage_mutations` (`received_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `pending_usage_mutations_interval_context_idx` ON `pending_usage_mutations` (`interval_id`,`context_fingerprint`);--> statement-breakpoint
CREATE TABLE `rejected_start_admissions` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`interval_id` text NOT NULL,
	`payload` text NOT NULL,
	`error_code` text NOT NULL,
	`error_message` text NOT NULL,
	`decided_at_ms` integer NOT NULL
);
