-- Custom SQL migration file, put your code below! --

-- Defensive reconciliation ahead of the next migration, which adds a validating
-- foreign key from platform_integrations.github_installation_id to
-- github_app_installations.id. That column was added in 0239 without a FK, so
-- any row whose github_installation_id no longer matches a live installation
-- would make the upcoming FK's full-table validation fail. Under current
-- application invariants this should not happen (github_app_installations rows
-- are only ever soft-deleted; the sole hard-delete path in
-- `anonymizeCloudUserData` already guards with a NOT EXISTS check against
-- remaining associations), but we null out any orphans here as a safety net so
-- the FK migration cannot fail on unexpected drift.
UPDATE "platform_integrations"
SET "github_installation_id" = NULL
WHERE "github_installation_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "github_app_installations"
    WHERE "github_app_installations"."id" = "platform_integrations"."github_installation_id"
  );
