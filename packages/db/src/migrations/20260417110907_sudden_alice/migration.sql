ALTER TABLE "kilocode_users" ADD COLUMN "email_domain" text;--> statement-breakpoint
CREATE INDEX "IDX_kilocode_users_email_domain" ON "kilocode_users" USING btree ("email_domain");