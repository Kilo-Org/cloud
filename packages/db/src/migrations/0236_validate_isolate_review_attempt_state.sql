COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" VALIDATE CONSTRAINT "code_review_attempt_reviewer_affinity_check";
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" VALIDATE CONSTRAINT "code_review_attempt_publication_target_check";
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" VALIDATE CONSTRAINT "code_review_attempt_publication_identity_check";
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" VALIDATE CONSTRAINT "code_review_attempt_publication_finalization_check";
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" VALIDATE CONSTRAINT "code_review_attempt_publication_release_check";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_code_review_attempt_publication_active_target" ON "cloud_agent_code_review_attempts" USING btree (lower("publication_state"->'identity'->'target'->>'repoFullName'),("publication_state"->'identity'->'target'->>'prNumber')) WHERE "cloud_agent_code_review_attempts"."publication_state" IS NOT NULL AND "cloud_agent_code_review_attempts"."publication_state"->>'released_at' IS NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_code_review_attempt_publication_recovery" ON "cloud_agent_code_review_attempts" USING btree ("updated_at") WHERE "cloud_agent_code_review_attempts"."publication_state" IS NOT NULL AND ("cloud_agent_code_review_attempts"."publication_state"->>'released_at' IS NULL OR "cloud_agent_code_review_attempts"."publication_state"->>'queue_wakeup_at' IS NULL);--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_code_review_attempt_publication_execution_user" ON "cloud_agent_code_review_attempts" USING btree (("publication_state"->'identity'->>'executionUserId')) WHERE "cloud_agent_code_review_attempts"."publication_state" IS NOT NULL;
--> statement-breakpoint
BEGIN;
