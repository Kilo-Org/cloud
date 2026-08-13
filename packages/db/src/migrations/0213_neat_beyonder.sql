DROP INDEX "UQ_user_data_exports_single_active";--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD COLUMN "subject_type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD CONSTRAINT "user_data_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_data_exports_single_active_org" ON "user_data_exports" USING btree ("organization_id") WHERE "user_data_exports"."status" IN ('queued', 'processing', 'finalizing') AND "user_data_exports"."subject_type" = 'organization';--> statement-breakpoint
CREATE INDEX "IDX_user_data_exports_org_created" ON "user_data_exports" USING btree ("organization_id","created_at","id") WHERE "user_data_exports"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_data_exports_single_active" ON "user_data_exports" USING btree ("kilo_user_id") WHERE "user_data_exports"."status" IN ('queued', 'processing', 'finalizing') AND "user_data_exports"."subject_type" = 'user';--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD CONSTRAINT "user_data_exports_subject_type_check" CHECK ("user_data_exports"."subject_type" IN ('user', 'organization'));--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD CONSTRAINT "user_data_exports_subject_shape" CHECK (("user_data_exports"."subject_type" = 'user' AND "user_data_exports"."organization_id" IS NULL)
        OR ("user_data_exports"."subject_type" = 'organization' AND "user_data_exports"."organization_id" IS NOT NULL));