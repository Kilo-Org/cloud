CREATE TABLE "agent_environment_profile_repo_bindings" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"repo_full_name" text NOT NULL,
	"platform" text DEFAULT 'github' NOT NULL,
	"profile_id" uuid NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_env_profile_repo_bindings_owner_check" CHECK ((
        ("agent_environment_profile_repo_bindings"."owned_by_user_id" IS NOT NULL AND "agent_environment_profile_repo_bindings"."owned_by_organization_id" IS NULL) OR
        ("agent_environment_profile_repo_bindings"."owned_by_user_id" IS NULL AND "agent_environment_profile_repo_bindings"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "agent_environment_profile_repo_bindings" ADD CONSTRAINT "agent_environment_profile_repo_bindings_profile_id_agent_environment_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_environment_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_repo_bindings" ADD CONSTRAINT "agent_environment_profile_repo_bindings_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environment_profile_repo_bindings" ADD CONSTRAINT "agent_environment_profile_repo_bindings_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profile_repo_bindings_user" ON "agent_environment_profile_repo_bindings" USING btree ("repo_full_name","platform","owned_by_user_id") WHERE "agent_environment_profile_repo_bindings"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_agent_env_profile_repo_bindings_org" ON "agent_environment_profile_repo_bindings" USING btree ("repo_full_name","platform","owned_by_organization_id") WHERE "agent_environment_profile_repo_bindings"."owned_by_organization_id" is not null;