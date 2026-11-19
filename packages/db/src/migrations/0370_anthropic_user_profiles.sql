-- The cleanup state table marks whether the table-creation transaction already applied, and each
-- column below is guarded on its own column. A failed concurrent index build commits these parts
-- without recording the migration, so every statement here must survive a retry.
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
		CREATE INDEX "IDX_anthropic_user_profile_deletions_deleted_at" ON "anthropic_user_profile_deletions" USING btree ("deleted_at");
	END IF;
END $$;--> statement-breakpoint
COMMIT;
--> statement-breakpoint
-- Each ADD COLUMN takes an ACCESS EXCLUSIVE lock on a busy table. One transaction that holds the
-- lock on kilocode_users while it waits for organizations deadlocks with live traffic that locks
-- the two tables in the opposite order, and PostgreSQL kills one side. Give each column its own
-- transaction, take the lock with a short wait, and retry inside the block: a failed attempt
-- releases the request, so traffic is never blocked for longer than the timeout.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('public.kilocode_users')
			AND attname = 'anthropic_user_profile_id'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "kilocode_users" ADD COLUMN "anthropic_user_profile_id" text;
			RETURN;
		EXCEPTION WHEN lock_not_available THEN
			attempt := attempt + 1;
			IF attempt >= 10 THEN
				RAISE;
			END IF;
			PERFORM pg_sleep(least(attempt, 5));
		END;
	END LOOP;
END $$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('public.organizations')
			AND attname = 'anthropic_user_profile_id'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "organizations" ADD COLUMN "anthropic_user_profile_id" text;
			RETURN;
		EXCEPTION WHEN lock_not_available THEN
			attempt := attempt + 1;
			IF attempt >= 10 THEN
				RAISE;
			END IF;
			PERFORM pg_sleep(least(attempt, 5));
		END;
	END LOOP;
END $$;
--> statement-breakpoint
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
