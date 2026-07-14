CREATE TABLE IF NOT EXISTS `attention_outbox` (
	`request_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer,
	`last_error` text,
	`raised_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attention_outbox_pending_idx` ON `attention_outbox` (`status`, `next_attempt_at`);
