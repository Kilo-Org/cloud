import { db } from '@/lib/drizzle';
import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

const installationIdPattern = /^[1-9][0-9]*$/;

export type GitHubInstallationBackfillResult = {
  scanned: number;
  canonicalCreated: number;
  linked: number;
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
          eq(platform_integrations.platform_installation_id, installationId),
          eq(platform_integrations.integration_status, 'active'),
          isNull(platform_integrations.github_disconnected_at),
          isNull(platform_integrations.suspended_at),
          isNull(platform_integrations.auth_invalid_at),
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
        .select({ id: github_app_installations.id })
        .from(github_app_installations)
        .where(
          and(
            eq(github_app_installations.github_app_type, appType),
            eq(github_app_installations.installation_id, installationId)
          )
        )
        .limit(1);
      if (!canonical) return;
      const updated = await tx
        .update(platform_integrations)
        .set({ github_installation_id: canonical.id })
        .where(
          and(
            eq(platform_integrations.id, row.id),
            isNull(platform_integrations.github_installation_id),
            eq(platform_integrations.integration_status, 'active'),
            isNull(platform_integrations.github_disconnected_at),
            isNull(platform_integrations.suspended_at),
            isNull(platform_integrations.auth_invalid_at)
          )
        );
      if ((updated.rowCount ?? 0) === 1) result.linked++;
    });
  }
  return result;
}
