COMMIT;--> statement-breakpoint
-- The migrator runs this file inside its own implicit transaction, so end that first: the ADD
-- COLUMN below must take its ACCESS EXCLUSIVE lock on the busy kilocode_users table in a dedicated
-- transaction with a short lock timeout and a bounded retry loop, guarded on the column's own
-- catalog state. A failed attempt releases its lock request, so traffic waits at most the timeout.
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
			AND attname = 'organization_trial_consumed_at'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "kilocode_users" ADD COLUMN "organization_trial_consumed_at" timestamp with time zone;
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
-- Backfill the per-user record for organizations that predate the column. `createOrganization`
-- stamps the creator's user row in the same transaction that grants a trial, so every later
-- creation carries its own record; this statement covers the history it cannot.
--
-- Which rows are a granted trial: `trial_granted` was added with default true, so every
-- organization created before it existed kept a trial window, and one created through a path
-- that grants no trial (a child organization, a later organization for a user who already spent
-- the offer) records false itself.
--
-- Which rows have a creator: within `createOrganization`, `created_by_kilo_user_id` comes only from
-- its `userId` argument, and the only production caller of `createOrganization` that passes one is
-- the self-service web create. The admin create (`createOrganization(input.name)`), SCIM directory
-- sync (`createOrganization(input.name, null, false)`) and child-organization creation write no
-- creator. The other writers of the column are a sales demo organization (which stamps the target
-- user itself), the development-only create route, and administrator reassignment. So a non-null
-- creator on a granted-trial organization is a user who created it, except after an administrator
-- reassignment: `updateCreatedBy` can point an existing organization at a user who did not create it,
-- and this statement stamps that user. The statement deliberately prefers that outcome: a record
-- that over-counts a used offer is a support correction, while a record that under-counts it cannot
-- be detected later, so the statement records conservatively.
--
-- Not covered here: organizations the previous build creates between this migration and
-- `promote-app`. Those rows carry a creator and a granted trial with no stamp. The same statement
-- is exported as `stampOrganizationTrialConsumption` from
-- `apps/web/src/scripts/db/backfill-organization-trial-consumption.ts` and is safe to repeat after
-- the promotion.
--
-- Two properties keep this statement cheap on the production table. It drives the update from the
-- set of creator ids as one array, so `kilocode_users` is probed through its primary-key index once
-- per creator (`= ANY (ARRAY(...))`) instead of scanned end to end; the `IN (SELECT ...)` spelling
-- of the same predicate becomes a hash semi join with a full sequential scan of `kilocode_users` as
-- the table grows, even though only the creators' rows change. And outside the migration's implicit
-- transaction it is its own transaction, so the row locks it takes on `kilocode_users` (the same
-- rows `enforceOrganizationCreationLimit` locks) are released as soon as the statement finishes
-- rather than at the end of the migration file. It locks only the users it stamps, and a concurrent
-- creation of a *different* user's organization is unaffected.
--
-- The server default `statement_timeout` cancels a write of this size on the production table, and
-- the default `lock_timeout` would fail the deploy on a transient wait for one of the creator rows a
-- live creation transaction holds. Lift both for this statement only, as
-- `0314_scheduled_briefing_snapshots.sql` does; the deploy job's `timeout-minutes` stays the bound.
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
UPDATE "kilocode_users"
SET "organization_trial_consumed_at" = now()
WHERE "organization_trial_consumed_at" IS NULL
  AND "id" = ANY (
    ARRAY(
      SELECT "created_by_kilo_user_id"
      FROM "organizations"
      WHERE "trial_granted" = true
        AND "created_by_kilo_user_id" IS NOT NULL
    )
  );--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
