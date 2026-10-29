ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_platform_check";--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_github_identity_check";--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_gitlab_identity_check";--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_bitbucket_identity_check";--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ALTER COLUMN "repo_full_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD COLUMN "repositories" jsonb;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_environments_repositories" ON "cloud_agent_environments" USING gin ("repositories" jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_identity_check" CHECK ((
        (
          "cloud_agent_environments"."repositories" IS NULL AND
          "cloud_agent_environments"."platform" IS NOT NULL AND
          "cloud_agent_environments"."repo_full_name" IS NOT NULL AND (
            (
              "cloud_agent_environments"."platform" = 'github' AND
              "cloud_agent_environments"."gitlab_clone_url" IS NULL AND
              "cloud_agent_environments"."bitbucket_workspace_uuid" IS NULL AND
              "cloud_agent_environments"."bitbucket_repository_uuid" IS NULL
            ) OR (
              "cloud_agent_environments"."platform" = 'gitlab' AND
              "cloud_agent_environments"."gitlab_clone_url" IS NOT NULL AND
              "cloud_agent_environments"."bitbucket_workspace_uuid" IS NULL AND
              "cloud_agent_environments"."bitbucket_repository_uuid" IS NULL
            ) OR (
              "cloud_agent_environments"."platform" = 'bitbucket' AND
              "cloud_agent_environments"."bitbucket_workspace_uuid" IS NOT NULL AND
              "cloud_agent_environments"."bitbucket_repository_uuid" IS NOT NULL AND
              "cloud_agent_environments"."gitlab_clone_url" IS NULL
            )
          )
        ) OR (
          "cloud_agent_environments"."repositories" IS NOT NULL AND
          jsonb_typeof("cloud_agent_environments"."repositories") = 'array' AND
          "cloud_agent_environments"."repositories" <> '[]'::jsonb AND
          "cloud_agent_environments"."platform" IS NULL AND
          "cloud_agent_environments"."repo_full_name" IS NULL AND
          "cloud_agent_environments"."gitlab_clone_url" IS NULL AND
          "cloud_agent_environments"."bitbucket_workspace_uuid" IS NULL AND
          "cloud_agent_environments"."bitbucket_repository_uuid" IS NULL
        )
      ));