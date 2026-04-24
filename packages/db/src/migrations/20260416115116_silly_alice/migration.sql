ALTER TABLE "kilocode_users" ADD COLUMN "normalized_email" text;--> statement-breakpoint
CREATE INDEX "IDX_kilocode_users_normalized_email" ON "kilocode_users" USING btree ("normalized_email");