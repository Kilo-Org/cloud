import 'server-only';

import { db } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';

/**
 * Keyset-paginated selectors that drive the GitLab credential migration.
 *
 * There is no job/queue table: a row's presence in one of these queries *is* its
 * "still needs work" state. Callers walk the table by passing the last id they
 * saw back as `afterId`; when a page returns fewer than `limit` rows the pass is
 * complete. Re-running from `afterId = null` re-selects only whatever still
 * matches — i.e. rows a pass could not resolve (see the per-row guards in
 * `backfillGitLabIntegration` / `scrubGitLabIntegration`).
 */

function assertPositiveInteger(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('GitLab credential migration batch size must be a positive integer');
  }
}

/**
 * GitLab integrations that still have a legacy plaintext credential in `metadata`
 * with no matching encrypted row yet — either a missing primary credential
 * (OAuth / PAT) or a `project_tokens` entry with no `project_access_token` row.
 */
export async function selectGitLabIntegrationsNeedingBackfill(
  limit: number,
  afterId: string | null
): Promise<string[]> {
  assertPositiveInteger(limit);
  const result = await db.execute<{ id: string }>(sql`
    SELECT i.id::text AS id
    FROM platform_integrations i
    WHERE i.platform = 'gitlab'
      AND jsonb_typeof(i.metadata) = 'object'
      AND (${afterId}::uuid IS NULL OR i.id > ${afterId}::uuid)
      AND (
        (
          jsonb_exists_any(i.metadata, ARRAY['access_token', 'refresh_token', 'client_secret'])
          AND NOT EXISTS (
            SELECT 1 FROM platform_oauth_credentials o
            WHERE o.platform_integration_id = i.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM platform_access_token_credentials a
            WHERE a.platform_integration_id = i.id
              AND a.provider_resource_id IS NULL
          )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_object_keys(
            CASE
              WHEN jsonb_typeof(i.metadata->'project_tokens') = 'object'
                THEN i.metadata->'project_tokens'
              ELSE '{}'::jsonb
            END
          ) AS keys(project_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM platform_access_token_credentials a
            WHERE a.platform_integration_id = i.id
              AND a.provider_credential_type = 'project_access_token'
              AND a.provider_resource_id = keys.project_id
          )
        )
      )
    ORDER BY i.id
    LIMIT ${limit}
  `);
  return result.rows.map(row => row.id);
}

/**
 * GitLab integrations that still carry plaintext token material AND whose
 * encrypted rows are already complete — the only rows it is safe to scrub.
 * "Complete" means: any plaintext primary credential has an encrypted primary
 * row, and every `project_tokens` key has a matching `project_access_token` row.
 * Rows whose backfill is incomplete are deliberately excluded so scrub can never
 * destroy the only copy of a token.
 */
export async function selectGitLabIntegrationsNeedingScrub(
  limit: number,
  afterId: string | null
): Promise<string[]> {
  assertPositiveInteger(limit);
  const result = await db.execute<{ id: string }>(sql`
    SELECT i.id::text AS id
    FROM platform_integrations i
    WHERE i.platform = 'gitlab'
      AND jsonb_typeof(i.metadata) = 'object'
      AND (${afterId}::uuid IS NULL OR i.id > ${afterId}::uuid)
      AND jsonb_exists_any(
        i.metadata,
        ARRAY['access_token', 'refresh_token', 'token_expires_at', 'client_secret', 'project_tokens']
      )
      AND (
        NOT jsonb_exists_any(
          i.metadata,
          ARRAY['access_token', 'refresh_token', 'token_expires_at', 'client_secret']
        )
        OR EXISTS (
          SELECT 1 FROM platform_oauth_credentials o
          WHERE o.platform_integration_id = i.id
        )
        OR EXISTS (
          SELECT 1 FROM platform_access_token_credentials a
          WHERE a.platform_integration_id = i.id
            AND a.provider_resource_id IS NULL
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_object_keys(
          CASE
            WHEN jsonb_typeof(i.metadata->'project_tokens') = 'object'
              THEN i.metadata->'project_tokens'
            ELSE '{}'::jsonb
          END
        ) AS keys(project_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM platform_access_token_credentials a
          WHERE a.platform_integration_id = i.id
            AND a.provider_credential_type = 'project_access_token'
            AND a.provider_resource_id = keys.project_id
        )
      )
    ORDER BY i.id
    LIMIT ${limit}
  `);
  return result.rows.map(row => row.id);
}
