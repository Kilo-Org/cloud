ALTER TABLE "kilocode_users" ADD COLUMN "openrouter_downstream_safety_identifier" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_kilocode_users_openrouter_downstream_safety_identifier" ON "kilocode_users" USING btree ("openrouter_downstream_safety_identifier") WHERE "kilocode_users"."openrouter_downstream_safety_identifier" IS NOT NULL;--> statement-breakpoint
BEGIN;