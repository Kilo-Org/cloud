DO $$
BEGIN
IF to_regclass('public.cloud_agent_pr_feedback_dispositions') IS NULL THEN
CREATE TABLE "cloud_agent_pr_feedback_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"attempt_id" uuid,
	"problem_key" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"disposition" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_id" text,
	"reply_comment_id" text,
	"reply_body" text,
	"replied_at" timestamp with time zone,
	"resolution_status" text DEFAULT 'not_applicable' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_pr_feedback_dispositions_disposition_check" CHECK ("cloud_agent_pr_feedback_dispositions"."disposition" IN ('addressed', 'already_addressed', 'disagreed', 'deferred', 'needs_input', 'not_actionable')),
	CONSTRAINT "cloud_agent_pr_feedback_dispositions_resolution_check" CHECK (("cloud_agent_pr_feedback_dispositions"."resolution_status" = 'not_applicable' AND "cloud_agent_pr_feedback_dispositions"."thread_id" IS NULL AND "cloud_agent_pr_feedback_dispositions"."resolved_at" IS NULL) OR ("cloud_agent_pr_feedback_dispositions"."resolution_status" = 'open' AND "cloud_agent_pr_feedback_dispositions"."thread_id" IS NOT NULL AND "cloud_agent_pr_feedback_dispositions"."resolved_at" IS NULL) OR ("cloud_agent_pr_feedback_dispositions"."resolution_status" = 'resolved' AND "cloud_agent_pr_feedback_dispositions"."thread_id" IS NOT NULL AND "cloud_agent_pr_feedback_dispositions"."resolved_at" IS NOT NULL AND "cloud_agent_pr_feedback_dispositions"."disposition" IN ('addressed', 'already_addressed'))),
	CONSTRAINT "cloud_agent_pr_feedback_dispositions_bounds_check" CHECK (length("cloud_agent_pr_feedback_dispositions"."problem_key") BETWEEN 1 AND 200 AND length("cloud_agent_pr_feedback_dispositions"."content_fingerprint") BETWEEN 1 AND 128 AND length("cloud_agent_pr_feedback_dispositions"."reason") BETWEEN 1 AND 2000 AND length("cloud_agent_pr_feedback_dispositions"."reply_body") <= 4000 AND jsonb_typeof("cloud_agent_pr_feedback_dispositions"."evidence") = 'array' AND jsonb_array_length("cloud_agent_pr_feedback_dispositions"."evidence") <= 10 AND length("cloud_agent_pr_feedback_dispositions"."evidence"::text) <= 65536)
);

CREATE TABLE "cloud_agent_pr_maintenance_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"worktree_id" text NOT NULL,
	"generation" integer NOT NULL,
	"pending_revision" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"session_id" text,
	"cloud_agent_session_id" text,
	"creation_operation_key" uuid NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"needs_input_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_pr_maintenance_attempts_status_check" CHECK ("cloud_agent_pr_maintenance_attempts"."status" IN ('creating', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
	CONSTRAINT "cloud_agent_pr_maintenance_attempts_version_check" CHECK ("cloud_agent_pr_maintenance_attempts"."generation" > 0 AND "cloud_agent_pr_maintenance_attempts"."pending_revision" >= 0 AND "cloud_agent_pr_maintenance_attempts"."ordinal" BETWEEN 1 AND 10 AND "cloud_agent_pr_maintenance_attempts"."delivery_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "cloud_agent_pr_maintenance_attempts_finished_check" CHECK (("cloud_agent_pr_maintenance_attempts"."status" IN ('creating', 'running', 'needs_input') AND "cloud_agent_pr_maintenance_attempts"."finished_at" IS NULL) OR ("cloud_agent_pr_maintenance_attempts"."status" IN ('completed', 'failed', 'stopped') AND "cloud_agent_pr_maintenance_attempts"."finished_at" IS NOT NULL)),
	CONSTRAINT "cloud_agent_pr_maintenance_attempts_payload_check" CHECK (jsonb_typeof("cloud_agent_pr_maintenance_attempts"."input") = 'object' AND length("cloud_agent_pr_maintenance_attempts"."input"::text) <= 524288 AND ("cloud_agent_pr_maintenance_attempts"."result" IS NULL OR (jsonb_typeof("cloud_agent_pr_maintenance_attempts"."result") = 'object' AND length("cloud_agent_pr_maintenance_attempts"."result"::text) <= 262144)))
);

ALTER TABLE "cloud_agent_pr_watches" DROP CONSTRAINT "cloud_agent_pr_watches_version_check";
ALTER TABLE "cloud_agent_pr_watches" ALTER COLUMN "expires_at" DROP NOT NULL;
ALTER TABLE "cli_sessions_v2" ADD COLUMN "chat_kind" text DEFAULT 'user' NOT NULL;
ALTER TABLE "cli_sessions_v2" ADD COLUMN "maintenance_watch_id" uuid;
ALTER TABLE "cli_sessions_v2" ADD COLUMN "maintenance_attempt_id" uuid;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "execution_status" text DEFAULT 'watching' NOT NULL;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "pending_since" timestamp with time zone;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "next_run_at" timestamp with time zone;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "last_assessed_at" timestamp with time zone;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "total_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "last_attempt_id" uuid;
ALTER TABLE "cloud_agent_pr_watches" ADD COLUMN "finished_at" timestamp with time zone;
ALTER TABLE "cloud_agent_pr_feedback_dispositions" ADD CONSTRAINT "cloud_agent_pr_feedback_dispositions_watch_id_cloud_agent_pr_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."cloud_agent_pr_watches"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cloud_agent_pr_feedback_dispositions" ADD CONSTRAINT "cloud_agent_pr_feedback_dispositions_attempt_id_cloud_agent_pr_maintenance_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."cloud_agent_pr_maintenance_attempts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "cloud_agent_pr_maintenance_attempts" ADD CONSTRAINT "cloud_agent_pr_maintenance_attempts_watch_id_cloud_agent_pr_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."cloud_agent_pr_watches"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_feedback_dispositions_problem" ON "cloud_agent_pr_feedback_dispositions" USING btree ("watch_id","problem_key","content_fingerprint");
CREATE INDEX "IDX_cloud_agent_pr_feedback_dispositions_attempt" ON "cloud_agent_pr_feedback_dispositions" USING btree ("attempt_id");
CREATE INDEX "IDX_cloud_agent_pr_feedback_dispositions_reply" ON "cloud_agent_pr_feedback_dispositions" USING btree ("reply_comment_id") WHERE "cloud_agent_pr_feedback_dispositions"."reply_comment_id" is not null;
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_live_workspace" ON "cloud_agent_pr_maintenance_attempts" USING btree ("worktree_id") WHERE "cloud_agent_pr_maintenance_attempts"."status" IN ('creating', 'running', 'needs_input');
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_operation" ON "cloud_agent_pr_maintenance_attempts" USING btree ("creation_operation_key");
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_message" ON "cloud_agent_pr_maintenance_attempts" USING btree ("message_id");
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_session" ON "cloud_agent_pr_maintenance_attempts" USING btree ("session_id") WHERE "cloud_agent_pr_maintenance_attempts"."session_id" is not null;
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_cloud_session" ON "cloud_agent_pr_maintenance_attempts" USING btree ("cloud_agent_session_id") WHERE "cloud_agent_pr_maintenance_attempts"."cloud_agent_session_id" is not null;
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_ordinal" ON "cloud_agent_pr_maintenance_attempts" USING btree ("watch_id","ordinal");
CREATE UNIQUE INDEX "UQ_cloud_agent_pr_maintenance_attempts_revision" ON "cloud_agent_pr_maintenance_attempts" USING btree ("watch_id","generation","pending_revision");
CREATE INDEX "IDX_cloud_agent_pr_maintenance_attempts_watch" ON "cloud_agent_pr_maintenance_attempts" USING btree ("watch_id","created_at");
CREATE INDEX "IDX_cloud_agent_pr_maintenance_attempts_due" ON "cloud_agent_pr_maintenance_attempts" USING btree ("next_run_at") WHERE "cloud_agent_pr_maintenance_attempts"."status" IN ('creating', 'running', 'needs_input') AND "cloud_agent_pr_maintenance_attempts"."next_run_at" IS NOT NULL;
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_last_attempt_id_cloud_agent_pr_maintenance_attempts_id_fk" FOREIGN KEY ("last_attempt_id") REFERENCES "public"."cloud_agent_pr_maintenance_attempts"("id") ON DELETE set null ON UPDATE no action;
END IF;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_maintenance_watch";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_maintenance_attempt";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_pr_watches_due";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_maintenance_watch" ON "cli_sessions_v2" USING btree ("maintenance_watch_id") WHERE "cli_sessions_v2"."maintenance_watch_id" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_maintenance_attempt" ON "cli_sessions_v2" USING btree ("maintenance_attempt_id") WHERE "cli_sessions_v2"."maintenance_attempt_id" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_pr_watches_due" ON "cloud_agent_pr_watches" USING btree ("next_run_at") WHERE "cloud_agent_pr_watches"."status" = 'watching' AND "cloud_agent_pr_watches"."next_run_at" IS NOT NULL;--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_execution_status_check" CHECK ("cloud_agent_pr_watches"."execution_status" IN ('watching', 'waiting_for_session', 'fixing', 'waiting_for_checks', 'needs_input'));--> statement-breakpoint
ALTER TABLE "cloud_agent_pr_watches" ADD CONSTRAINT "cloud_agent_pr_watches_version_check" CHECK ("cloud_agent_pr_watches"."generation" > 0 AND "cloud_agent_pr_watches"."pending_revision" >= 0 AND "cloud_agent_pr_watches"."pr_number" > 0 AND "cloud_agent_pr_watches"."total_attempts" >= 0);
