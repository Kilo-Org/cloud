ALTER TABLE "agent_briefing_reports" ALTER COLUMN "local_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "kind" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD COLUMN "evidence_recorded_before" timestamp with time zone;