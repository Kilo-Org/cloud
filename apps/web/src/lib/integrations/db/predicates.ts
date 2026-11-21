import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PLATFORM } from '../core/constants';
import type { Owner } from '../core/types';
import type { GitHubAppType } from '../platforms/github/app-selector';

/**
 * Owner scope for every `platform_integrations` query builder.
 */
export function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? eq(platform_integrations.owned_by_user_id, owner.id)
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

/**
 * GitHub app-type scope that includes legacy rows.
 *
 * A row written before `github_app_type` existed is a Standard row, so every
 * reader that must see it passes its app type here. Writers that name an app
 * type use an exact match instead; see `exactAppTypeCondition` in
 * `platform-integrations.ts`.
 */
export function effectiveAppTypeCondition(appType: GitHubAppType) {
  return appType === 'standard'
    ? sql`(${platform_integrations.github_app_type} = 'standard' OR ${platform_integrations.github_app_type} IS NULL)`
    : eq(platform_integrations.github_app_type, 'lite');
}

/**
 * One live GitHub association of an owner, reduced to the identity of the
 * installation slot it occupies.
 */
export type GitHubInstallationSlot = {
  installationId: string | null;
  appType: GitHubAppType | null;
};

/**
 * Whether a live association of the owner occupies an installation slot that
 * the association being written must not share.
 *
 * A GitHub installation slot is the installation id together with the app
 * type, which is what `github_app_installations` keys on, what the peer
 * lookups scope by, and what the primary-association selection compares. A
 * row without an installation id occupies no slot, and a row written before
 * `github_app_type` existed is a Standard row.
 *
 * Every writer that applies the organization single-installation rule calls
 * this, so the rule has one definition.
 */
export function occupiesAnotherGitHubInstallationSlot(
  existing: GitHubInstallationSlot,
  candidate: { installationId: string; appType: GitHubAppType }
): boolean {
  if (existing.installationId === null) return false;
  return (
    existing.installationId !== candidate.installationId ||
    (existing.appType ?? 'standard') !== candidate.appType
  );
}

/**
 * The installation slots an organization's live GitHub associations occupy, in
 * the shape the shared slot predicate reads. This is the one read of that
 * state: the install gate and every writer that applies the single-installation
 * rule read it, so they cannot drift. A writer that already holds the
 * organization lock passes its transaction instead of reading outside it.
 */
export async function getOrganizationGitHubInstallationSlots(
  organizationId: string,
  transaction?: DrizzleTransaction
): Promise<GitHubInstallationSlot[]> {
  const client = transaction ?? db;
  return await client
    .select({
      installationId: platform_integrations.platform_installation_id,
      appType: platform_integrations.github_app_type,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        // A locally disconnected connection has relinquished its slot.
        isNull(platform_integrations.github_disconnected_at)
      )
    );
}
