-- Insert-triggered autovacuum on microdollar_usage. With the server defaults it fires only after
-- 20% of the table has been inserted again, so the newest pages stay not-all-visible and every
-- index-only scan of recent rows (the spend-alert hourly rollup) fetches each row from the heap.
-- A fixed insert threshold keeps the newest pages all-visible. An insert-only vacuum skips pages
-- that are already all-visible and bypasses index vacuuming while dead tuples are few, so each run
-- is small. Drizzle cannot declare table storage parameters, so this is a custom migration.
--
-- Autovacuum parameters take SHARE UPDATE EXCLUSIVE, which does not conflict with reads or writes
-- but does wait for a running vacuum of the table. Wait briefly and retry instead of queueing.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF (
		SELECT coalesce(reloptions, '{}') @> ARRAY[
			'autovacuum_vacuum_insert_scale_factor=0',
			'autovacuum_vacuum_insert_threshold=500000'
		]
		FROM pg_class
		WHERE oid = to_regclass('public.microdollar_usage')
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "microdollar_usage" SET (
				autovacuum_vacuum_insert_scale_factor = 0,
				autovacuum_vacuum_insert_threshold = 500000
			);
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
