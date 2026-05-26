CREATE TABLE "cloud_agent_code_review_gate_syncs" (
	"code_review_id" uuid PRIMARY KEY NOT NULL,
	"desired_status" text NOT NULL,
	"desired_gate_result" text,
	"desired_terminal_reason" text,
	"desired_error_message" text,
	"desired_revision" integer DEFAULT 1 NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_redacted" text,
	"terminal_confirmation_required" boolean DEFAULT false NOT NULL,
	"last_ambiguous_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_code_review_gate_syncs_desired_status_check" CHECK ("cloud_agent_code_review_gate_syncs"."desired_status" IN ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "cloud_agent_code_review_gate_syncs_desired_gate_result_check" CHECK ("cloud_agent_code_review_gate_syncs"."desired_gate_result" IS NULL OR "cloud_agent_code_review_gate_syncs"."desired_gate_result" IN ('pass', 'fail')),
	CONSTRAINT "cloud_agent_code_review_gate_syncs_sync_status_check" CHECK ("cloud_agent_code_review_gate_syncs"."sync_status" IN ('pending', 'processing', 'retry', 'synced', 'skipped')),
	CONSTRAINT "cloud_agent_code_review_gate_syncs_desired_revision_check" CHECK ("cloud_agent_code_review_gate_syncs"."desired_revision" >= 1),
	CONSTRAINT "cloud_agent_code_review_gate_syncs_attempt_count_check" CHECK ("cloud_agent_code_review_gate_syncs"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_gate_syncs" ADD CONSTRAINT "cloud_agent_code_review_gate_syncs_code_review_id_cloud_agent_code_reviews_id_fk" FOREIGN KEY ("code_review_id") REFERENCES "public"."cloud_agent_code_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_gate_syncs_due" ON "cloud_agent_code_review_gate_syncs" USING btree ("sync_status","next_retry_at","updated_at") WHERE "cloud_agent_code_review_gate_syncs"."sync_status" IN ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_gate_syncs_claimed" ON "cloud_agent_code_review_gate_syncs" USING btree ("claimed_at","code_review_id") WHERE "cloud_agent_code_review_gate_syncs"."sync_status" = 'processing';--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_gate_syncs_failures" ON "cloud_agent_code_review_gate_syncs" USING btree ("last_error_code","updated_at") WHERE "cloud_agent_code_review_gate_syncs"."last_error_code" IS NOT NULL;