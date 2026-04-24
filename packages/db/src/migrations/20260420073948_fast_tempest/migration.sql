ALTER TABLE "kilocode_users" ADD COLUMN "signup_ip" text;--> statement-breakpoint
CREATE INDEX "IDX_kilocode_users_signup_ip_created_at" ON "kilocode_users" USING btree ("signup_ip","created_at");