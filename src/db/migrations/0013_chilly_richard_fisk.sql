ALTER TABLE "kilocode_users" ADD COLUMN "completed_welcome_form" boolean DEFAULT false NOT NULL;
UPDATE "kilocode_users" SET "completed_welcome_form" = true;