COMMIT; -- Custom SQL migration file, put your code below! --
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_workflow_canonical";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_canonical" ON "platform_integrations" USING btree ("github_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "UQ_platform_integrations_github_workflow_identity";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_github_workflow_identity" ON "platform_integrations" USING btree (COALESCE("github_app_type", 'standard'),"platform_installation_id") WHERE "platform_integrations"."github_connection_role" = 'workflow';
--> statement-breakpoint
BEGIN;
-->  statement-breakpoint
WITH eligible AS (
  SELECT pi.*,
    COALESCE(pi.metadata, '{}'::jsonb) ?| ARRAY['pending_approval', 'completed_installation'] AS has_pending_history,
    EXISTS (SELECT 1 FROM deployments d WHERE d.platform_integration_id = pi.id)
    OR EXISTS (SELECT 1 FROM app_builder_projects p WHERE p.git_platform_integration_id = pi.id)
    OR EXISTS (SELECT 1 FROM cloud_agent_code_reviews r WHERE r.platform_integration_id = pi.id AND r.status IN ('pending', 'queued', 'running'))
    OR EXISTS (SELECT 1 FROM bot_requests b WHERE b.platform_integration_id = pi.id AND b.status = 'pending')
    OR EXISTS (SELECT 1 FROM agent_configs a WHERE a.platform = 'github'
      AND (a.owned_by_user_id = pi.owned_by_user_id OR a.owned_by_organization_id = pi.owned_by_organization_id)
      AND (a.is_enabled OR a.config->>'review_memory_enabled' = 'true')) AS has_workflow
  FROM platform_integrations pi
  WHERE pi.platform = 'github' AND pi.integration_type = 'app'
    AND pi.platform_installation_id ~ '^[1-9][0-9]*$'
    AND (pi.github_app_type IN ('standard', 'lite') OR pi.github_app_type IS NULL)
    AND NOT (COALESCE(pi.metadata, '{}'::jsonb) ? 'github_dedup')
    AND pi.integration_status <> 'pending'
    AND (pi.github_installation_id IS NOT NULL OR (
      pi.integration_status = 'active' AND pi.suspended_at IS NULL AND pi.auth_invalid_at IS NULL
      AND pi.github_disconnected_at IS NULL
    ))
), ranked AS MATERIALIZED (
  SELECT id, github_installation_id,
    count(*) FILTER (WHERE has_workflow) OVER identity AS workflow_claims,
    count(*) FILTER (WHERE github_connection_role = 'workflow') OVER identity AS assigned_workflow_claims,
    count(*) FILTER (WHERE github_connection_role = 'agent_only') OVER identity AS agent_only_claims,
    count(*) FILTER (WHERE has_pending_history) OVER identity AS pending_histories,
    count(*) FILTER (WHERE github_installation_id IS NULL) OVER identity AS unbound_count,
    count(*) OVER identity AS association_count,
    row_number() OVER (PARTITION BY COALESCE(github_app_type, 'standard'), platform_installation_id
      ORDER BY (github_connection_role = 'workflow') DESC NULLS LAST, has_workflow DESC, created_at, id) AS position
  FROM eligible
  WINDOW identity AS (PARTITION BY COALESCE(github_app_type, 'standard'), platform_installation_id)
)
UPDATE platform_integrations pi
SET github_connection_role = CASE WHEN ranked.position = 1 THEN 'workflow' ELSE 'agent_only' END
FROM ranked
WHERE pi.id = ranked.id AND ranked.workflow_claims <= 1
  AND pi.github_connection_role IS NULL
  AND (ranked.assigned_workflow_claims = 1 OR ranked.agent_only_claims = 0)
  AND (ranked.association_count = 1 OR ranked.workflow_claims = 1 OR ranked.pending_histories = 0)
  AND (ranked.association_count = 1 OR ranked.unbound_count = 0);
