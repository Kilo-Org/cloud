ALTER TABLE "organizations" ADD COLUMN "parent_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_organization_id_organizations_id_fk" FOREIGN KEY ("parent_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_organizations_parent_organization_id" ON "organizations" USING btree ("parent_organization_id");--> statement-breakpoint
BEGIN;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_not_parented_by_self_check" CHECK ("organizations"."parent_organization_id" IS NULL OR "organizations"."parent_organization_id" <> "organizations"."id");
