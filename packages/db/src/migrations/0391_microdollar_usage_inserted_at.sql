-- Hand-written because the generated `ADD COLUMN ... DEFAULT now()` evaluates now() once and
-- stores the result as the value of every existing row, which would stamp the whole table with
-- the migration time. Adding the column without a default and setting the default in the same
-- statement leaves existing rows NULL and applies now() only to rows inserted afterwards. Neither
-- form rewrites the table.
--
-- ADD COLUMN takes ACCESS EXCLUSIVE on microdollar_usage, which blocks every usage insert while it
-- is held. The migrator applies every pending migration in one transaction, so give the statement
-- its own transaction: the lock is released as soon as the column exists, not when the whole
-- batch commits. Wait briefly and retry instead of queueing; a failed attempt releases its lock
-- request. The column guard skips a retried deploy without taking the lock.
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
		WHERE attrelid = to_regclass('public.microdollar_usage')
			AND attname = 'inserted_at'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "microdollar_usage"
				ADD COLUMN "inserted_at" timestamp with time zone,
				ALTER COLUMN "inserted_at" SET DEFAULT now();
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
