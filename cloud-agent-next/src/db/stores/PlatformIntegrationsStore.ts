/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { SqlStore } from '../SqlStore.js';
import {
  platform_integrations,
  PlatformIntegrationLookupSchema,
  type PlatformIntegrationLookup,
} from '../tables/platform-integrations.table.js';
import { organization_memberships } from '../tables/organization-memberships.table.js';

type FindInstallationParams = {
  repoOwner: string;
  userId: string;
  orgId?: string;
};

export class PlatformIntegrationsStore extends SqlStore {
  /**
   * Find a GitHub App installation ID for a given repo owner and user/org context.
   *
   * SECURITY: When looking up org installations, we JOIN with organization_memberships
   * to verify the user is actually a member of the organization. This prevents users
   * from accessing installations for orgs they don't belong to.
   *
   * Prioritizes org installations over user installations.
   */
  async findGitHubInstallation(
    params: FindInstallationParams
  ): Promise<PlatformIntegrationLookup | null> {
    const rows = await this.query(
      /* sql */ `
        SELECT
          ${platform_integrations.platform_installation_id},
          ${platform_integrations.platform_account_login},
          ${platform_integrations.github_app_type}
        FROM ${platform_integrations}
        -- For org installations, verify user is a member of the org
        LEFT JOIN ${organization_memberships}
          ON ${platform_integrations.owned_by_organization_id} = ${organization_memberships.organization_id}
          AND ${organization_memberships.kilo_user_id} = $3
        WHERE ${platform_integrations.platform} = 'github'
          AND ${platform_integrations.integration_type} = 'app'
          AND ${platform_integrations.integration_status} = 'active'
          AND ${platform_integrations.platform_account_login} = $1
          AND (
            -- Org installation: must match org ID AND user must be a member
            (${platform_integrations.owned_by_organization_id} IS NOT NULL
             AND ${platform_integrations.owned_by_organization_id} = $2::uuid
             AND ${organization_memberships.id} IS NOT NULL)
            OR
            -- User installation: must match user ID directly
            (${platform_integrations.owned_by_user_id} IS NOT NULL
             AND ${platform_integrations.owned_by_user_id} = $3)
          )
        ORDER BY
          CASE WHEN ${platform_integrations.owned_by_organization_id} IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
      `,
      { 1: params.repoOwner, 2: params.orgId ?? null, 3: params.userId }
    );

    if (rows.length === 0) {
      return null;
    }

    return PlatformIntegrationLookupSchema.parse(rows[0]);
  }
}
