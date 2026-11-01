ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "manual_operation_key" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_user_manual_operation_key" ON "cloud_agent_code_reviews" USING btree ("owned_by_user_id","manual_operation_key") WHERE "cloud_agent_code_reviews"."owned_by_user_id" IS NOT NULL AND "cloud_agent_code_reviews"."manual_operation_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_cloud_agent_code_reviews_org_manual_operation_key" ON "cloud_agent_code_reviews" USING btree ("owned_by_organization_id","manual_operation_key") WHERE "cloud_agent_code_reviews"."owned_by_organization_id" IS NOT NULL AND "cloud_agent_code_reviews"."manual_operation_key" IS NOT NULL;--> statement-breakpoint
BEGIN;
