DROP INDEX "agent_briefing_reports_window";--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "kind" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "evidence_recorded_before" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_briefing_reports_window" ON "agent_briefing_reports" USING btree ("kilo_user_id","context_key","local_date") WHERE "agent_briefing_reports"."kind" = 'scheduled';--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD CONSTRAINT "agent_briefing_reports_kind" CHECK ("agent_briefing_reports"."kind" IN ('scheduled', 'one_off'));--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD CONSTRAINT "agent_briefing_reports_one_off" CHECK ("agent_briefing_reports"."kind" <> 'one_off' OR ("agent_briefing_reports"."timezone" IS NOT NULL AND "agent_briefing_reports"."language" IS NOT NULL AND "agent_briefing_reports"."evidence_recorded_before" IS NOT NULL AND "agent_briefing_reports"."next_refresh_at" IS NULL));