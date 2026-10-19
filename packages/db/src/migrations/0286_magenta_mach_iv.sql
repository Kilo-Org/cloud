CREATE TABLE "agent_briefing_context_preferences" (
	"kilo_user_id" text NOT NULL,
	"context_key" text NOT NULL,
	"organization_id" uuid,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"max_duration_seconds" integer DEFAULT 600 NOT NULL,
	"max_spend_microdollars" bigint DEFAULT 2000000 NOT NULL,
	CONSTRAINT "agent_briefing_context_preferences_kilo_user_id_context_key_pk" PRIMARY KEY("kilo_user_id","context_key"),
	CONSTRAINT "agent_briefing_context_limits" CHECK ("agent_briefing_context_preferences"."max_duration_seconds" BETWEEN 1 AND 600 AND "agent_briefing_context_preferences"."max_spend_microdollars" > 0)
);
--> statement-breakpoint
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
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "agent_briefing_preferences" (
	"kilo_user_id" text PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"night_start" text DEFAULT '22:00' NOT NULL,
	"morning_start" text DEFAULT '08:00' NOT NULL,
	"morning_end" text DEFAULT '12:00' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"notifications_enabled" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_briefing_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"context_key" text NOT NULL,
	"organization_id" uuid,
	"local_date" text NOT NULL,
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
	"notification_sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "status_transition_id" text;--> statement-breakpoint
ALTER TABLE "agent_briefing_context_preferences" ADD CONSTRAINT "agent_briefing_context_preferences_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_context_preferences" ADD CONSTRAINT "agent_briefing_context_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_events" ADD CONSTRAINT "agent_briefing_events_session_fk" FOREIGN KEY ("session_id","kilo_user_id") REFERENCES "public"."cli_sessions_v2"("session_id","kilo_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_preferences" ADD CONSTRAINT "agent_briefing_preferences_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD CONSTRAINT "agent_briefing_reports_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_briefing_reports" ADD CONSTRAINT "agent_briefing_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_briefing_events_user_window" ON "agent_briefing_events" USING btree ("kilo_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_events_session_window" ON "agent_briefing_events" USING btree ("session_id","kilo_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_preferences_due" ON "agent_briefing_preferences" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_briefing_reports_window" ON "agent_briefing_reports" USING btree ("kilo_user_id","context_key","local_date");--> statement-breakpoint
CREATE INDEX "agent_briefing_reports_user_history" ON "agent_briefing_reports" USING btree ("kilo_user_id","cutoff_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_reports_active" ON "agent_briefing_reports" USING btree ("morning_end_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_reports_refresh_due" ON "agent_briefing_reports" USING btree ("next_refresh_at");--> statement-breakpoint
CREATE INDEX "agent_briefing_reports_charge_due" ON "agent_briefing_reports" USING btree ("next_charge_check_at");