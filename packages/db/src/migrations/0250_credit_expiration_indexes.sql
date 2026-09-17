COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_kilocode_users_next_credit_expiration_at" ON "kilocode_users" USING btree ("next_credit_expiration_at") WHERE "kilocode_users"."next_credit_expiration_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_next_credit_expiration_at" ON "organizations" USING btree ("next_credit_expiration_at") WHERE "organizations"."next_credit_expiration_at" IS NOT NULL;--> statement-breakpoint
BEGIN;