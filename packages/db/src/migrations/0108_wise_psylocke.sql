WITH ranked_slack_installations AS (
  SELECT
    "id",
    "platform_installation_id",
    row_number() OVER (
      PARTITION BY "platform_installation_id"
      ORDER BY ("integration_status" = 'active') DESC, "updated_at" DESC NULLS LAST, "installed_at" DESC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC
    ) AS "row_number"
  FROM "platform_integrations"
  WHERE "platform" = 'slack'
    AND "platform_installation_id" IS NOT NULL
), duplicate_slack_installations AS (
  SELECT "id", "platform_installation_id"
  FROM ranked_slack_installations
  WHERE "row_number" > 1
)
UPDATE "platform_integrations"
SET
  "platform_installation_id" = NULL,
  "integration_status" = 'suspended',
  "suspended_at" = now(),
  "suspended_by" = 'duplicate_slack_workspace_migration',
  "metadata" = coalesce("platform_integrations"."metadata", '{}'::jsonb)
    || jsonb_build_object(
      'duplicate_slack_platform_installation_id', duplicate_slack_installations."platform_installation_id",
      'duplicate_slack_platform_installation_detached_at', now()
    ),
  "updated_at" = now()
FROM duplicate_slack_installations
WHERE "platform_integrations"."id" = duplicate_slack_installations."id";--> statement-breakpoint
UPDATE "platform_integrations"
SET
  "integration_status" = 'suspended',
  "suspended_at" = coalesce(
    "suspended_at",
    ("metadata"->>'duplicate_slack_platform_installation_detached_at')::timestamptz,
    now()
  ),
  "suspended_by" = coalesce("suspended_by", 'duplicate_slack_workspace_migration'),
  "updated_at" = now()
WHERE "platform" = 'slack'
  AND "platform_installation_id" IS NULL
  AND "metadata" ? 'duplicate_slack_platform_installation_id'
  AND "integration_status" IS DISTINCT FROM 'suspended';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_platform_integrations_slack_platform_inst" ON "platform_integrations" USING btree ("platform","platform_installation_id") WHERE "platform_integrations"."platform" = 'slack' AND "platform_integrations"."platform_installation_id" IS NOT NULL;
