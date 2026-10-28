CREATE TABLE "agent_briefing_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"context_key" text NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"timezone" text NOT NULL,
	"language" text NOT NULL,
	"local_date" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"night_start_at" timestamp with time zone NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"morning_end_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_charge_check_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"facts" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"generation_id" text,
	"generation_started_at" timestamp with time zone,
	"generation_finished_at" timestamp with time zone,
	"generation_deadline_at" timestamp with time zone,
	"generation_max_cost" bigint,
	"notification_sent_at" timestamp with time zone,
	"job_due_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_briefing_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_briefing_events" CASCADE;--> statement-breakpoint
DROP TABLE "agent_briefing_reports" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_briefing_context_preferences" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "briefing_excerpt" jsonb;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "briefing_excerpt_scope_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_briefing_snapshots" ADD CONSTRAINT "agent_briefing_snapshots_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_snapshots" ADD CONSTRAINT "agent_briefing_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_briefing_snapshots_window" ON "agent_briefing_snapshots" USING btree ("kilo_user_id","context_key","local_date");--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_user_history" ON "agent_briefing_snapshots" USING btree ("kilo_user_id","cutoff_at","id");--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_job_due" ON "agent_briefing_snapshots" USING btree ("job_due_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_expiry" ON "agent_briefing_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_charge_due" ON "agent_briefing_snapshots" USING btree ("next_charge_check_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_notification_due" ON "agent_briefing_snapshots" USING btree ("morning_end_at","cutoff_at") WHERE "agent_briefing_snapshots"."notification_sent_at" is null;--> statement-breakpoint
CREATE INDEX "agent_briefing_snapshots_running_deadline" ON "agent_briefing_snapshots" USING btree ("generation_deadline_at") WHERE "agent_briefing_snapshots"."summary"->>'status' = 'running';--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_briefing_activity" ON "cli_sessions_v2" USING btree ("kilo_user_id","organization_id","last_activity_at" DESC NULLS LAST,"session_id");--> statement-breakpoint
BEGIN;
--> statement-breakpoint
ALTER TABLE "agent_briefing_context_preferences" DROP COLUMN "ai_enabled";