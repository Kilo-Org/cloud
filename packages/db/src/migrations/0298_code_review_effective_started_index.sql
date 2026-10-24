COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_cloud_agent_code_reviews_started_at_effective" ON "cloud_agent_code_reviews" USING btree (COALESCE("started_at", "updated_at", "created_at")) WHERE "cloud_agent_code_reviews"."status" NOT IN ('pending', 'queued') AND COALESCE("cloud_agent_code_reviews"."terminal_reason", '') <> 'abandoned';
--> statement-breakpoint
BEGIN;