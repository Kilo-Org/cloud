CREATE TABLE "app_builder_project_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"cloud_agent_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text NOT NULL,
	CONSTRAINT "UQ_app_builder_project_sessions_cloud_agent_session_id" UNIQUE("cloud_agent_session_id")
);
--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD COLUMN "git_repo_full_name" text;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD COLUMN "git_platform_integration_id" uuid;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD COLUMN "migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_builder_project_sessions" ADD CONSTRAINT "app_builder_project_sessions_project_id_app_builder_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."app_builder_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_app_builder_project_sessions_project_id" ON "app_builder_project_sessions" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "app_builder_project_sessions" ("project_id", "cloud_agent_session_id", "reason")
SELECT "id", "session_id", 'initial'
FROM "app_builder_projects"
WHERE "session_id" IS NOT NULL
ON CONFLICT ("cloud_agent_session_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "app_builder_projects" ADD CONSTRAINT "app_builder_projects_git_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("git_platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;