COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_user_activity";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_user_activity" ON "cli_sessions_v2" USING btree ("kilo_user_id",coalesce("last_activity_at", "created_at"));
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
