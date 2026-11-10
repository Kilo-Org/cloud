CREATE TABLE "cloud_agent_repository_environment_defaults" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"repository_full_name" text NOT NULL,
	"repository_platform" text NOT NULL,
	"repository_key" text NOT NULL,
	"environment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_repo_env_defaults_owner_check" CHECK ((
        ("cloud_agent_repository_environment_defaults"."owned_by_user_id" IS NOT NULL AND "cloud_agent_repository_environment_defaults"."owned_by_organization_id" IS NULL) OR
        ("cloud_agent_repository_environment_defaults"."owned_by_user_id" IS NULL AND "cloud_agent_repository_environment_defaults"."owned_by_organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_repository_environment_defaults" ADD CONSTRAINT "cloud_agent_repository_environment_defaults_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_repository_environment_defaults" ADD CONSTRAINT "cloud_agent_repository_environment_defaults_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_repo_env_defaults_user" ON "cloud_agent_repository_environment_defaults" USING btree ("owned_by_user_id","repository_platform","repository_key") WHERE "cloud_agent_repository_environment_defaults"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_repo_env_defaults_org" ON "cloud_agent_repository_environment_defaults" USING btree ("owned_by_organization_id","repository_platform","repository_key") WHERE "cloud_agent_repository_environment_defaults"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_repo_env_defaults_org" ON "cloud_agent_repository_environment_defaults" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_repo_env_defaults_user" ON "cloud_agent_repository_environment_defaults" USING btree ("owned_by_user_id");