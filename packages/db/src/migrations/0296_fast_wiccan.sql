COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_operation_ledgers_admin_renewal_batch" ON "operation_ledgers" USING btree ("intent","resource_key","status") WHERE "operation_ledgers"."domain" = 'admin_kiloclaw_stripe_renewals';--> statement-breakpoint
BEGIN;
