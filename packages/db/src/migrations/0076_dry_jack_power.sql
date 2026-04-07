CREATE TABLE "agent_environment_profile_repo_bindings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"repo_full_name" text NOT NULL,
	"platform" text DEFAULT 'github' NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_environment_profile_repo_bindings" ADD CONSTRAINT "agent_environment_profile_repo_bindings_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profile_repo_bindings_repo_platform_profile" ON "agent_environment_profile_repo_bindings" USING btree ("repo_full_name","platform","profile_id");