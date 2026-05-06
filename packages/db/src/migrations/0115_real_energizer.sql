DROP INDEX "idx_reasons";--> statement-breakpoint
CREATE INDEX "idx_stytch_fingerprints_reasons_gin" ON "stytch_fingerprints" USING gin ("reasons");