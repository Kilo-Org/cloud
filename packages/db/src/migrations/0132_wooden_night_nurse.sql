COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_microdollar_usage_metadata_session_id_created_at" ON "microdollar_usage_metadata" USING btree ("session_id","created_at");--> statement-breakpoint
BEGIN;
