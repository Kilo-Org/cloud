ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_head_ref" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_head_sha" text;--> statement-breakpoint
ALTER TABLE "cli_sessions_v2" ADD COLUMN "pr_link_verified_at" timestamp with time zone;

-->  statement-breakpoint
-- The old branch key can cache the same PR under multiple head-ref names.
-- Keep the newest observation per PR and owner; preserve older rows as unlinked
-- cache entries. This table has no id, so its old unique branch key breaks ties.
WITH ranked AS (
  SELECT
    git_url,
    git_branch,
    owned_by_organization_id,
    owned_by_user_id,
    row_number() OVER (
      PARTITION BY git_url, pr_number, owned_by_organization_id, owned_by_user_id
      ORDER BY pr_last_synced_at DESC, updated_at DESC, git_branch COLLATE "C" DESC
    ) AS observation_rank
  FROM github_branch_pull_requests
  WHERE pr_number IS NOT NULL
)
UPDATE github_branch_pull_requests AS cache
SET pr_number = NULL
FROM ranked
WHERE ranked.observation_rank > 1
  AND cache.git_url = ranked.git_url
  AND cache.git_branch = ranked.git_branch
  AND cache.owned_by_organization_id IS NOT DISTINCT FROM ranked.owned_by_organization_id
  AND cache.owned_by_user_id IS NOT DISTINCT FROM ranked.owned_by_user_id;