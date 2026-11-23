import { platform_integrations } from '@kilocode/db/schema';
import { eq, isNull, sql, type SQL } from 'drizzle-orm';
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
 * SQL condition for a GitHub association that still occupies an installation
 * slot for its owner.
 *
 * Only a local disconnect relinquishes the slot: a suspended or auth-invalid
 * association keeps it, because `observeGitHubInstallationLifecycle` restores
 * the association to active without touching its role. Every place that decides
 * whether an owner still holds an installation reads this condition, so the
 * single-installation rule has one definition.
 */
export function liveGitHubInstallationSlotSql(): SQL {
  return isNull(platform_integrations.github_disconnected_at);
}

/**
 * Whether a live association holds the installation slot its identity names. A
 * row without an installation id — a request GitHub has not installed yet —
 * holds none.
 */
export function holdsGitHubInstallationSlot(existing: { installationId: string | null }): boolean {
  return existing.installationId !== null;
}

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
  if (!holdsGitHubInstallationSlot(existing)) return false;
  return (
    existing.installationId !== candidate.installationId ||
    (existing.appType ?? 'standard') !== candidate.appType
  );
}
