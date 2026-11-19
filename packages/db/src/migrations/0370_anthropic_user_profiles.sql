-- The first transaction is atomic, so the cleanup state table marks whether all of it already applied.
-- A failed concurrent index build commits this part without recording the migration.
DO $$
BEGIN
	IF to_regclass('public.anthropic_user_profile_cleanup_state') IS NULL THEN
		CREATE TABLE "anthropic_user_profile_cleanup_state" (
			"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
			"next_page" text,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			CONSTRAINT "anthropic_user_profile_cleanup_state_singleton" CHECK ("anthropic_user_profile_cleanup_state"."id" = 1)
		);
		CREATE TABLE "anthropic_user_profile_deletions" (
			"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
			"user_profile_id" text NOT NULL,
			"reason" text NOT NULL,
			"kilo_user_id" text,
			"profile_created_at" timestamp with time zone,
			"profile_updated_at" timestamp with time zone,
			"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
			"attempt_count" integer DEFAULT 0 NOT NULL,
			"last_attempt_at" timestamp with time zone,
			"deleted_at" timestamp with time zone,
			CONSTRAINT "UQ_anthropic_user_profile_deletions_user_profile_id" UNIQUE("user_profile_id")
		);
		ALTER TABLE "kilocode_users" ADD COLUMN "anthropic_user_profile_id" text;
		ALTER TABLE "organizations" ADD COLUMN "anthropic_user_profile_id" text;
		CREATE INDEX "IDX_anthropic_user_profile_deletions_deleted_at" ON "anthropic_user_profile_deletions" USING btree ("deleted_at");
	END IF;
END $$;--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- A cancelled build leaves an INVALID index under its name; drop it so a retry rebuilds it.
DROP INDEX CONCURRENTLY IF EXISTS "IDX_kilocode_users_anthropic_user_profile_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_kilocode_users_anthropic_user_profile_id" ON "kilocode_users" USING btree ("anthropic_user_profile_id") WHERE "kilocode_users"."anthropic_user_profile_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_organizations_anthropic_user_profile_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_organizations_anthropic_user_profile_id" ON "organizations" USING btree ("anthropic_user_profile_id") WHERE "organizations"."anthropic_user_profile_id" IS NOT NULL;--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
