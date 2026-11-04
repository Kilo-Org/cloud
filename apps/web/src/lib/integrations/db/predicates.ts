import { platform_integrations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
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
