ALTER TABLE "credit_transactions" ADD COLUMN "consumed_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "retired_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "paid_credit_policy" text;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "credit_source" text;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "source_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "refund_principal_microdollars" bigint;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_credit_transactions_source_transaction_id" ON "credit_transactions" USING btree ("source_transaction_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_kilocode_users_next_credit_expiration_at" ON "kilocode_users" USING btree ("next_credit_expiration_at") WHERE "kilocode_users"."next_credit_expiration_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_next_credit_expiration_at" ON "organizations" USING btree ("next_credit_expiration_at") WHERE "organizations"."next_credit_expiration_at" IS NOT NULL;
--> statement-breakpoint
BEGIN;