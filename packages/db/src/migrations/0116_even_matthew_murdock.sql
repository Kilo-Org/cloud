ALTER TABLE "transactional_email_log" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "transactional_email_log" ADD CONSTRAINT "transactional_email_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_transactional_email_log_organization_id" ON "transactional_email_log" USING btree ("organization_id");
