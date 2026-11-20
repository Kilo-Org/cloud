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
-- Every organization created before this column existed defaults to trial_granted = true, so its
-- creator has used the offer. Stamp those creators so a later organization does not grant them a
-- second trial. This UPDATE is its own statement after the committed DDL above; inside the DO
-- block's transaction a retried ALTER would roll the backfill back.
UPDATE "kilocode_users"
SET "organization_trial_consumed_at" = now()
WHERE "organization_trial_consumed_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "organizations"
    WHERE "organizations"."created_by_kilo_user_id" = "kilocode_users"."id"
      AND "organizations"."trial_granted" = true
  );
