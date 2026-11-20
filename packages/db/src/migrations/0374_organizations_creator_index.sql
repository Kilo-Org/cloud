COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_organizations_created_by_kilo_user_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_created_by_kilo_user_id" ON "organizations" USING btree ("created_by_kilo_user_id");--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
