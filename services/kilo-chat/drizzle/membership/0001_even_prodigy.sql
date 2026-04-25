DROP INDEX `conversations_sandbox_id_idx`;--> statement-breakpoint
CREATE INDEX `conversations_sandbox_activity_idx` ON `conversations` (`sandbox_id`,coalesce("last_activity_at", "joined_at") desc);