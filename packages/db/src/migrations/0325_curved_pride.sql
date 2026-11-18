ALTER TABLE "kilocode_users" ADD COLUMN "external_id" text DEFAULT null;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_kilocode_users_external_id" ON "kilocode_users" USING btree ("external_id") WHERE "kilocode_users"."external_id" IS NOT NULL;
--> statement-breakpoint
BEGIN;