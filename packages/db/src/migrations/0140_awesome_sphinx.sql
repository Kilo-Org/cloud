COMMIT;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_microdollar_usage_metadata_session_id_created_at";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_microdollar_usage_metadata_session_id" ON "microdollar_usage_metadata" USING btree ("session_id") WHERE "microdollar_usage_metadata"."session_id" is not null;--> statement-breakpoint
BEGIN;
