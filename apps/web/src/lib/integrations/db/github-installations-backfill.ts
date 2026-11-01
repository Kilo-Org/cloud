import { db } from '@kilocode/web-shared/lib/drizzle';
import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

const installationIdPattern = /^[1-9][0-9]*$/;

export type GitHubInstallationBackfillResult = {
  scanned: number;
  canonicalCreated: number;
  linked: number;
  roleAssigned: number;
  skipped: number;
  skippedInvalid: number;
  skippedDeduplicated: number;
  skippedAmbiguous: number;
  skippedUnhealthy: number;
  scanComplete: boolean;
  nextCursor: string | null;
};

export async function backfillGitHubInstallations(
  limit = 100,
  afterId?: string
): Promise<GitHubInstallationBackfillResult> {
  const pageSize = Math.max(1, Math.min(limit, 500));
  const selectedRows = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_type, 'app'),
        isNull(platform_integrations.github_installation_id),
        afterId ? gt(platform_integrations.id, afterId) : undefined
      )
    )
    .orderBy(asc(platform_integrations.id))
    .limit(pageSize + 1);
  const scanComplete = selectedRows.length <= pageSize;
  const rows = selectedRows.slice(0, pageSize);
  const result = {
    scanned: rows.length,
    canonicalCreated: 0,
    linked: 0,
    roleAssigned: 0,
    skipped: 0,
    skippedInvalid: 0,
    skippedDeduplicated: 0,
    skippedAmbiguous: 0,
    skippedUnhealthy: 0,
    scanComplete,
    nextCursor: scanComplete ? null : (rows.at(-1)?.id ?? null),
  };
  for (const row of rows) {
    const installationId = row.platform_installation_id;
    if (
      typeof row.metadata === 'object' &&
      row.metadata !== null &&
      'github_dedup' in row.metadata
    ) {
      result.skipped++;
      result.skippedDeduplicated++;
      continue;
    }
    if (
      !installationId ||
      !installationIdPattern.test(installationId) ||
      row.integration_status !== 'active'
    ) {
      result.skipped++;
      result.skippedInvalid++;
      continue;
    }
    if (
      row.github_disconnected_at ||
      row.suspended_at ||
      row.auth_invalid_at ||
      !['standard', 'lite', null].includes(row.github_app_type)
    ) {
      result.skipped++;
      result.skippedUnhealthy++;
      continue;
    }
    const appType = row.github_app_type ?? 'standard';
    const peers = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.integration_type, 'app'),
          eq(platform_integrations.platform_installation_id, installationId),
          eq(platform_integrations.integration_status, 'active'),
          isNull(platform_integrations.github_disconnected_at),
          isNull(platform_integrations.suspended_at),
          isNull(platform_integrations.auth_invalid_at),
          sql`NOT (COALESCE(${platform_integrations.metadata}, '{}'::jsonb) ? 'github_dedup')`,
          appType === 'standard'
            ? sql`(${platform_integrations.github_app_type} = 'standard' OR ${platform_integrations.github_app_type} IS NULL)`
            : eq(platform_integrations.github_app_type, appType)
        )
      )
      .limit(2);
    if (peers.length !== 1 || peers[0]?.id !== row.id) {
      result.skipped++;
      result.skippedAmbiguous++;
      continue;
    }
    await db.transaction(async tx => {
      const inserted = await tx
        .insert(github_app_installations)
        .values({
          github_app_type: appType,
          installation_id: installationId,
          account_id: row.platform_account_id,
          account_login: row.platform_account_login,
          permissions: row.permissions,
          scopes: row.scopes,
          repository_access: row.repository_access,
          repositories: row.repositories,
          repositories_synced_at: row.repositories_synced_at,
          lifecycle_state: 'active',
          observed_at: row.installed_at,
        })
        .onConflictDoNothing()
        .returning({ id: github_app_installations.id });
      if (inserted.length > 0) result.canonicalCreated++;
      const [canonical] = await tx
        .select({
          id: github_app_installations.id,
          lifecycle_state: github_app_installations.lifecycle_state,
          suspended_at: github_app_installations.suspended_at,
          deleted_at: github_app_installations.deleted_at,
          auth_invalid_at: github_app_installations.auth_invalid_at,
        })
        .from(github_app_installations)
        .where(
          and(
            eq(github_app_installations.github_app_type, appType),
            eq(github_app_installations.installation_id, installationId)
          )
        )
        .limit(1);
      if (!canonical) return;
      // The role is the stored half of the shared organization workflow
      // connection definition, whose canonical check only accepts the active
      // record of this identity. Linking to a canonical record that is
      // suspended, deleted or auth-invalid is a repair the organizations that
      // read this row still need, so the link happens either way, but such a
      // row keeps its role: a stored `workflow` would otherwise report the
      // organization connected with an installation no lookup will use.
      const canonicalIsUsable =
        canonical.lifecycle_state === 'active' &&
        !canonical.suspended_at &&
        !canonical.deleted_at &&
        !canonical.auth_invalid_at;
      const updated = await tx
        .update(platform_integrations)
        .set({
          github_installation_id: canonical.id,
          // Linking a legacy row to its canonical installation is the last
          // writer that could leave a real organization installation without a
          // connection role, which the organization Security Agent reads to
          // decide between its setup state and its dashboard. Give the role to
          // the same rows migration 0322 classified — a healthy, organization
          // owned GitHub App association whose installation identity no other
          // row claims — and leave every other row exactly as it is.
          ...(canonicalIsUsable
            ? {
                github_connection_role: sql`
            CASE WHEN (
              ${platform_integrations.github_connection_role} IS NULL
              AND ${platform_integrations.owned_by_organization_id} IS NOT NULL
              AND ${platform_integrations.integration_type} = 'app'
              AND NOT (COALESCE(${platform_integrations.metadata}, '{}'::jsonb) ? 'github_dedup')
              AND NOT EXISTS (
                SELECT 1
                FROM platform_integrations claimed
                WHERE claimed.github_connection_role = 'workflow'
                  AND claimed.id <> ${platform_integrations.id}
                  AND claimed.platform_installation_id = ${platform_integrations.platform_installation_id}
                  AND COALESCE(claimed.github_app_type, 'standard') =
                    COALESCE(${platform_integrations.github_app_type}, 'standard')
              )
            ) THEN 'workflow'
            ELSE ${platform_integrations.github_connection_role}
            END
          `,
              }
            : {}),
        })
        .where(
          and(
            eq(platform_integrations.id, row.id),
            isNull(platform_integrations.github_installation_id),
            eq(platform_integrations.integration_status, 'active'),
            isNull(platform_integrations.github_disconnected_at),
            isNull(platform_integrations.suspended_at),
            isNull(platform_integrations.auth_invalid_at)
          )
        )
        .returning({ role: platform_integrations.github_connection_role });
      if (updated.length === 1) {
        result.linked++;
        if (row.github_connection_role === null && updated[0]?.role === 'workflow') {
          result.roleAssigned++;
        }
      }
    });
  }
  return result;
}

export async function reportGitHubConnectionRoleReconciliation(limit = 100, cursor?: string) {
  return db
    .select({
      integrationId: platform_integrations.id,
      installationId: platform_integrations.platform_installation_id,
      appType: platform_integrations.github_app_type,
      canonicalId: platform_integrations.github_installation_id,
      status: platform_integrations.integration_status,
      disconnectedAt: platform_integrations.github_disconnected_at,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        isNull(platform_integrations.github_connection_role),
        cursor ? gt(platform_integrations.id, cursor) : undefined
      )
    )
    .orderBy(platform_integrations.id)
    .limit(limit);
}
