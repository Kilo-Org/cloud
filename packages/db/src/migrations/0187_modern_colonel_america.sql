ALTER TABLE "kilocode_users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "can_view_sessions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD CONSTRAINT "kilocode_users_is_super_admin_requires_admin_check" CHECK (NOT "kilocode_users"."is_super_admin" OR "kilocode_users"."is_admin");--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD CONSTRAINT "kilocode_users_can_view_sessions_requires_admin_check" CHECK (NOT "kilocode_users"."can_view_sessions" OR "kilocode_users"."is_admin");-->  statement-breakpoint
-- Preserve the previous grant-authority boundary exactly: both the hosted domain
-- and the case-sensitive email suffix must identify a kilocode.ai account.
UPDATE "kilocode_users"
SET "is_super_admin" = true
WHERE "is_admin" = true
  AND "hosted_domain" = 'kilocode.ai'
  AND "google_user_email" LIKE '%@kilocode.ai';
