COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_container_usage_interval_session";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_container_usage_interval_session" ON "container_usage_interval" USING btree ("session_id") WHERE "container_usage_interval"."session_id" IS NOT NULL;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
BEGIN;
