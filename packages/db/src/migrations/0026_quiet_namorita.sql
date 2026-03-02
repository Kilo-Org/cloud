CREATE TABLE "cloud_agent_feedback" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text,
	"cloud_agent_session_id" text,
	"organization_id" uuid,
	"model" text,
	"repository" text,
	"is_streaming" boolean,
	"message_count" integer,
	"feedback_text" text NOT NULL,
	"recent_messages" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_feedback" ADD CONSTRAINT "cloud_agent_feedback_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cloud_agent_feedback" ADD CONSTRAINT "cloud_agent_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_feedback_created_at" ON "cloud_agent_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_feedback_kilo_user_id" ON "cloud_agent_feedback" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_feedback_cloud_agent_session_id" ON "cloud_agent_feedback" USING btree ("cloud_agent_session_id");