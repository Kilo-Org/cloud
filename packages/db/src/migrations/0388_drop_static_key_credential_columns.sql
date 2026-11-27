-- Hand-written so that each transaction locks at most one busy table: the generated SQL drops both
-- columns in one transaction, which would keep the first table locked against traffic while it
-- waits for the second.
--
-- Locks are taken with a short wait and retried inside the block: a failed attempt rolls back its
-- subtransaction and releases its locks, so traffic never waits behind the migration for longer
-- than the timeout. Each block is skipped once its column is gone, so a retried deploy does not
-- take the lock again.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('public.coding_plan_key_inventory')
			AND attname = 'encrypted_api_key'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "coding_plan_key_inventory" DROP COLUMN IF EXISTS "encrypted_api_key";
			RETURN;
		EXCEPTION WHEN lock_not_available THEN
			attempt := attempt + 1;
			IF attempt >= 10 THEN
				RAISE;
			END IF;
			PERFORM pg_sleep(least(attempt, 5));
		END;
	END LOOP;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('public.openai_chatgpt_connections')
			AND attname = 'encrypted_connection'
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			ALTER TABLE "openai_chatgpt_connections" DROP COLUMN IF EXISTS "encrypted_connection";
			RETURN;
		EXCEPTION WHEN lock_not_available THEN
			attempt := attempt + 1;
			IF attempt >= 10 THEN
				RAISE;
			END IF;
			PERFORM pg_sleep(least(attempt, 5));
		END;
	END LOOP;
END $$;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
