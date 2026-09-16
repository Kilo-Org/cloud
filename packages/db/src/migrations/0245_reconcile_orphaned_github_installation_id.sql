-- Custom SQL migration file, put your code below! --

-- Pre-flight guard ahead of the migration that adds a validating foreign key
-- from platform_integrations.github_installation_id to
-- github_app_installations.id. That column was added in 0239 without a FK, so
-- any row whose github_installation_id no longer matches a live installation
-- would make the upcoming FK's full-table validation fail.
--
-- This does NOT silently repair orphans: for an otherwise-healthy association
-- with github_app_type IS NULL, nulling its github_installation_id would make
-- it newly eligible for the legacy bot-link fallback lookup
-- (findIntegrationByInstallationId's unscoped path treats
-- github_app_type = 'standard' OR IS NULL as equivalent), which is an
-- authorization-eligibility change, not a harmless cleanup. Verified
-- production orphan_count = 0 ahead of this migration, so instead of mutating
-- data behind an operator's back, assert the invariant holds and fail loudly
-- if it doesn't, so any unexpected drift is investigated and repaired
-- deliberately rather than silently reclassified.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM "platform_integrations"
  WHERE "github_installation_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "github_app_installations"
      WHERE "github_app_installations"."id" = "platform_integrations"."github_installation_id"
    );

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Found % platform_integrations row(s) with a github_installation_id that does not match any github_app_installations row. The next migration adds a validating FOREIGN KEY on this column and will fail until these are investigated and repaired (do not blindly null them: for a row with github_app_type IS NULL, that would make it newly eligible for the legacy bot-link fallback lookup, which is an authorization-eligibility change, not a harmless cleanup).', orphan_count;
  END IF;
END $$;
