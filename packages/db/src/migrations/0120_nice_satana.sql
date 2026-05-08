ALTER TABLE "transactional_email_log" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactional_email_log" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "transactional_email_log" ADD CONSTRAINT "transactional_email_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_transactional_email_log_organization_id" ON "transactional_email_log" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "transactional_email_log" ADD CONSTRAINT "CHK_transactional_email_log_owner" CHECK ("transactional_email_log"."user_id" IS NOT NULL OR "transactional_email_log"."organization_id" IS NOT NULL);