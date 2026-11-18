DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cloud_agent_environments' AND column_name = 'repositories'
  ) THEN
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_platform_check";
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_github_identity_check";
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_gitlab_identity_check";
ALTER TABLE "cloud_agent_environments" DROP CONSTRAINT "cloud_agent_environments_bitbucket_identity_check";
ALTER TABLE "cloud_agent_environments" ALTER COLUMN "platform" DROP NOT NULL;
ALTER TABLE "cloud_agent_environments" ALTER COLUMN "repo_full_name" DROP NOT NULL;
ALTER TABLE "cloud_agent_environments" ADD COLUMN "repositories" jsonb;
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
  END IF;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_environments_repositories";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_cloud_agent_environments_repositories" ON "cloud_agent_environments" USING gin ("repositories" jsonb_path_ops);--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
