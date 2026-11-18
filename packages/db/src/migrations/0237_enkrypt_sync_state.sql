CREATE TABLE "enkrypt_sync_state" (
	"job_name" text PRIMARY KEY NOT NULL,
	"attempt_id" uuid,
	"last_attempt_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_outcome" text,
	"last_failure_category" text,
	"last_counts" jsonb,
	"last_success_counts" jsonb,
	"verified_models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"baseline_matched_count" integer,
	CONSTRAINT "enkrypt_sync_state_singleton" CHECK ("enkrypt_sync_state"."job_name" = 'enkrypt'),
	CONSTRAINT "enkrypt_sync_state_outcome" CHECK ("enkrypt_sync_state"."last_outcome" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "enkrypt_sync_state_baseline" CHECK ("enkrypt_sync_state"."baseline_matched_count" >= 0)
);
