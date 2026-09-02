ALTER TABLE "cloud_agent_code_review_attempts" ADD COLUMN "reviewer_backend" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD COLUMN "reviewer_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD COLUMN "reviewer_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD COLUMN "publication_state" jsonb;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "blocked_by_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "code_review_attempt_reviewer_affinity_check" CHECK ("cloud_agent_code_review_attempts"."reviewer_backend" IN ('unselected', 'legacy', 'isolate')
        AND ("cloud_agent_code_review_attempts"."reviewer_execution_id" IS NULL) = ("cloud_agent_code_review_attempts"."reviewer_selected_at" IS NULL)
        AND ("cloud_agent_code_review_attempts"."reviewer_backend" != 'unselected' OR "cloud_agent_code_review_attempts"."reviewer_execution_id" IS NULL)
        AND ("cloud_agent_code_review_attempts"."reviewer_backend" != 'isolate' OR "cloud_agent_code_review_attempts"."reviewer_execution_id" IS NOT NULL)
        AND ("cloud_agent_code_review_attempts"."reviewer_execution_id" IS NULL OR "cloud_agent_code_review_attempts"."reviewer_execution_id" = "cloud_agent_code_review_attempts"."id")) NOT VALID;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "code_review_attempt_publication_target_check" CHECK ("cloud_agent_code_review_attempts"."publication_state" IS NULL OR (
        "cloud_agent_code_review_attempts"."publication_state"->'identity'->'target'->>'host' = 'github.com'
        AND "cloud_agent_code_review_attempts"."publication_state"->'identity'->'target'->>'repoFullName' ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$'
        AND jsonb_typeof("cloud_agent_code_review_attempts"."publication_state"->'identity'->'target'->'prNumber') = 'number'
        AND ("cloud_agent_code_review_attempts"."publication_state"->'identity'->'target'->>'prNumber')::integer > 0
      ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "code_review_attempt_publication_identity_check" CHECK ("cloud_agent_code_review_attempts"."publication_state" IS NULL OR (
        "cloud_agent_code_review_attempts"."reviewer_backend" = 'isolate'
        AND ("cloud_agent_code_review_attempts"."publication_state"->'identity'->>'generation')::uuid IS NOT NULL
        AND "cloud_agent_code_review_attempts"."publication_state"->'identity'->>'reviewId' = "cloud_agent_code_review_attempts"."code_review_id"::text
        AND "cloud_agent_code_review_attempts"."publication_state"->'identity'->>'attemptId' = "cloud_agent_code_review_attempts"."id"::text
      ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "code_review_attempt_publication_finalization_check" CHECK ("cloud_agent_code_review_attempts"."publication_state" IS NULL OR (
        "cloud_agent_code_review_attempts"."publication_state"->>'web_finalization' IN ('pending', 'uncertain', 'settled', 'suppressed')
      ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "code_review_attempt_publication_release_check" CHECK ("cloud_agent_code_review_attempts"."publication_state"->>'released_at' IS NULL OR (
        "cloud_agent_code_review_attempts"."publication_state"->'safety'->>'quiescent' = 'true'
        AND "cloud_agent_code_review_attempts"."publication_state"->'safety'->>'execution' IN ('completed', 'failed', 'cancelled')
        AND "cloud_agent_code_review_attempts"."publication_state"->'safety'->>'publication' IN ('not_started', 'settled')
        AND "cloud_agent_code_review_attempts"."publication_state"->>'web_finalization' IN ('settled', 'suppressed')
      ) IS TRUE) NOT VALID;