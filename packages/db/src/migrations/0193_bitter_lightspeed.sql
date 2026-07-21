ALTER TABLE "cloud_agent_session_runs" DROP CONSTRAINT "cloud_agent_session_runs_failure_classification_check";--> statement-breakpoint
ALTER TABLE "cloud_agent_session_runs" ADD COLUMN "failure_responsibility" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_session_runs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN "failure_responsibility" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN "failure_reason" text;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_session_runs_responsibility_reason_terminal" ON "cloud_agent_session_runs" USING btree ("failure_responsibility","failure_reason","terminal_at") WHERE "cloud_agent_session_runs"."status" = 'failed';--> statement-breakpoint
BEGIN;