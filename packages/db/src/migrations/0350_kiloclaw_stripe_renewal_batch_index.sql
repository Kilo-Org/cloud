COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_operation_ledgers_admin_renewal_batch";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_operation_ledgers_admin_renewal_batch" ON "operation_ledgers" USING btree ("intent","resource_key","status") WHERE "operation_ledgers"."domain" = 'admin_kiloclaw_stripe_renewals';--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
