-- The first version of 0314 dropped these objects on databases where it applied.
-- Recreate them only where they are missing, so production takes no table locks here.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_briefing_context_preferences' AND column_name = 'ai_enabled'
	) THEN
		ALTER TABLE "agent_briefing_context_preferences" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;
	END IF;

	IF to_regclass('public.agent_briefing_events') IS NULL THEN
		CREATE TABLE "agent_briefing_events" (
			"id" text PRIMARY KEY NOT NULL,
			"kilo_user_id" text NOT NULL,
			"session_id" text NOT NULL,
			"organization_id" uuid,
			"kind" text NOT NULL,
			"occurred_at" timestamp with time zone NOT NULL,
			"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
			"status" text,
			"title" text,
			"url" text,
			"payload" jsonb,
			CONSTRAINT "agent_briefing_events_session_fk" FOREIGN KEY ("session_id","kilo_user_id") REFERENCES "public"."cli_sessions_v2"("session_id","kilo_user_id") ON DELETE cascade ON UPDATE no action
		);
		CREATE INDEX "agent_briefing_events_user_window" ON "agent_briefing_events" USING btree ("kilo_user_id","occurred_at");
		CREATE INDEX "agent_briefing_events_session_window" ON "agent_briefing_events" USING btree ("session_id","kilo_user_id","occurred_at");
	END IF;

	IF to_regclass('public.agent_briefing_reports') IS NULL THEN
		CREATE TABLE "agent_briefing_reports" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"kilo_user_id" text NOT NULL,
			"context_key" text NOT NULL,
			"organization_id" uuid,
			"local_date" text,
			"night_start_at" timestamp with time zone NOT NULL,
			"cutoff_at" timestamp with time zone NOT NULL,
			"morning_end_at" timestamp with time zone NOT NULL,
			"published_at" timestamp with time zone,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
			"next_refresh_at" timestamp with time zone DEFAULT now(),
			"next_charge_check_at" timestamp with time zone,
			"read_at" timestamp with time zone,
			"dismissed_at" timestamp with time zone,
			"revision" integer DEFAULT 1 NOT NULL,
			"evidence_hash" text NOT NULL,
			"facts" jsonb NOT NULL,
			"summary" jsonb NOT NULL,
			"generation_id" text,
			"generation_started_at" timestamp with time zone,
			"generation_finished_at" timestamp with time zone,
			"generation_deadline_at" timestamp with time zone,
			"generation_revision" integer,
			"generation_max_cost" bigint,
			"notification_sent_at" timestamp with time zone,
			"kind" text DEFAULT 'scheduled' NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"timezone" text,
			"language" text,
			"evidence_recorded_before" timestamp with time zone,
			CONSTRAINT "agent_briefing_reports_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action,
			CONSTRAINT "agent_briefing_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
		);
		CREATE UNIQUE INDEX "agent_briefing_reports_window" ON "agent_briefing_reports" USING btree ("kilo_user_id","context_key","local_date");
		CREATE INDEX "agent_briefing_reports_user_history" ON "agent_briefing_reports" USING btree ("kilo_user_id","cutoff_at");
		CREATE INDEX "agent_briefing_reports_active" ON "agent_briefing_reports" USING btree ("morning_end_at");
		CREATE INDEX "agent_briefing_reports_refresh_due" ON "agent_briefing_reports" USING btree ("next_refresh_at");
		CREATE INDEX "agent_briefing_reports_charge_due" ON "agent_briefing_reports" USING btree ("next_charge_check_at");
	END IF;
END $$;
