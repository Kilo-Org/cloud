ALTER TABLE "organizations" ADD COLUMN "directory_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "directory_group_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "directory_idp_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "external_org_id" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_organizations_directory_group_id" ON "organizations" USING btree ("directory_group_id") WHERE "organizations"."directory_group_id" IS NOT NULL AND "organizations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_organizations_external_org_id" ON "organizations" USING btree ("external_org_id") WHERE "organizations"."external_org_id" IS NOT NULL AND "organizations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_directory_idp_id" ON "organizations" USING btree ("directory_idp_id") WHERE "organizations"."directory_idp_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_directory_id" ON "organizations" USING btree ("directory_id") WHERE "organizations"."directory_id" IS NOT NULL;

--> statement-breakpoint
BEGIN;