COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_microdollar_usage_created_at_rollup" ON "microdollar_usage" USING btree ("created_at","kilo_user_id","organization_id","cost");--> statement-breakpoint
BEGIN;
