COMMIT;--> statement-breakpoint
-- The migrator runs this file inside its own implicit transaction, so end that first: the ADD
-- COLUMN below must take its ACCESS EXCLUSIVE lock in a dedicated transaction with a short lock
-- timeout and a bounded retry loop, guarded on the column's own catalog state.
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
			AND attname = 'trial_granted'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "organizations" ADD COLUMN "trial_granted" boolean DEFAULT true NOT NULL;
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
