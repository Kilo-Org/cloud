COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_stytch_fingerprints_reasons_gin" ON "stytch_fingerprints" USING gin ("reasons");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_reasons";--> statement-breakpoint
BEGIN;
