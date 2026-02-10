CREATE TABLE "app_builder_feedback" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text,
	"project_id" uuid,
	"session_id" text,
	"model" text,
	"preview_status" text,
	"is_streaming" boolean,
	"message_count" integer,
	"feedback_text" text NOT NULL,
	"recent_messages" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_builder_feedback" ADD CONSTRAINT "app_builder_feedback_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "app_builder_feedback" ADD CONSTRAINT "app_builder_feedback_project_id_app_builder_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."app_builder_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_app_builder_feedback_created_at" ON "app_builder_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_feedback_kilo_user_id" ON "app_builder_feedback" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_app_builder_feedback_project_id" ON "app_builder_feedback" USING btree ("project_id");