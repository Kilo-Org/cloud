CREATE TABLE "cloud_agent_environment_vars" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_cloud_agent_environment_vars_environment_key" UNIQUE("environment_id","key")
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_environments" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"gitlab_clone_url" text,
	"bitbucket_workspace_uuid" uuid,
	"bitbucket_repository_uuid" uuid,
	"commands" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_environments_owner_check" CHECK ((
        ("cloud_agent_environments"."owned_by_user_id" IS NOT NULL AND "cloud_agent_environments"."owned_by_organization_id" IS NULL) OR
        ("cloud_agent_environments"."owned_by_user_id" IS NULL AND "cloud_agent_environments"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "cloud_agent_environments_platform_check" CHECK ("cloud_agent_environments"."platform" IN ('github', 'gitlab', 'bitbucket')),
	CONSTRAINT "cloud_agent_environments_github_identity_check" CHECK ((
        ("cloud_agent_environments"."platform" = 'github') = (
          "cloud_agent_environments"."gitlab_clone_url" IS NULL AND
          "cloud_agent_environments"."bitbucket_workspace_uuid" IS NULL AND
          "cloud_agent_environments"."bitbucket_repository_uuid" IS NULL
        )
      )),
	CONSTRAINT "cloud_agent_environments_gitlab_identity_check" CHECK ((
        ("cloud_agent_environments"."platform" = 'gitlab') = (
          "cloud_agent_environments"."gitlab_clone_url" IS NOT NULL AND
          "cloud_agent_environments"."bitbucket_workspace_uuid" IS NULL AND
          "cloud_agent_environments"."bitbucket_repository_uuid" IS NULL
        )
      )),
	CONSTRAINT "cloud_agent_environments_bitbucket_identity_check" CHECK ((
        ("cloud_agent_environments"."platform" = 'bitbucket') = (
          "cloud_agent_environments"."bitbucket_workspace_uuid" IS NOT NULL AND
          "cloud_agent_environments"."bitbucket_repository_uuid" IS NOT NULL AND
          "cloud_agent_environments"."gitlab_clone_url" IS NULL
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_environment_vars" ADD CONSTRAINT "cloud_agent_environment_vars_environment_id_cloud_agent_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."cloud_agent_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_environment_vars_environment_id" ON "cloud_agent_environment_vars" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_github_user" ON "cloud_agent_environments" USING btree ("owned_by_user_id","repo_full_name","name") WHERE "cloud_agent_environments"."platform" = 'github' AND "cloud_agent_environments"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_github_org" ON "cloud_agent_environments" USING btree ("owned_by_organization_id","repo_full_name","name") WHERE "cloud_agent_environments"."platform" = 'github' AND "cloud_agent_environments"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_gitlab_user" ON "cloud_agent_environments" USING btree ("owned_by_user_id","gitlab_clone_url","name") WHERE "cloud_agent_environments"."platform" = 'gitlab' AND "cloud_agent_environments"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_gitlab_org" ON "cloud_agent_environments" USING btree ("owned_by_organization_id","gitlab_clone_url","name") WHERE "cloud_agent_environments"."platform" = 'gitlab' AND "cloud_agent_environments"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_bitbucket_user" ON "cloud_agent_environments" USING btree ("owned_by_user_id","bitbucket_workspace_uuid","bitbucket_repository_uuid","name") WHERE "cloud_agent_environments"."platform" = 'bitbucket' AND "cloud_agent_environments"."owned_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_environments_bitbucket_org" ON "cloud_agent_environments" USING btree ("owned_by_organization_id","bitbucket_workspace_uuid","bitbucket_repository_uuid","name") WHERE "cloud_agent_environments"."platform" = 'bitbucket' AND "cloud_agent_environments"."owned_by_organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_environments_user_id" ON "cloud_agent_environments" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_environments_org_id" ON "cloud_agent_environments" USING btree ("owned_by_organization_id");