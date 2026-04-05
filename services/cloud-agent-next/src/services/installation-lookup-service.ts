import type { WorkerDb } from '@kilocode/db/client';
import { platform_integrations, organization_memberships } from '@kilocode/db/schema';
import { eq, and, isNotNull, or, sql } from 'drizzle-orm';

type InstallationLookupEnv = {
  HYPERDRIVE?: { connectionString: string };
};

type LookupParams = {
  githubRepo: string;
  userId: string;
  orgId?: string;
};

type LookupResult = {
  installationId: string;
  accountLogin: string;
  githubAppType: 'standard' | 'lite';
} | null;

export class InstallationLookupService {
  private db: WorkerDb | null = null;

  constructor(private env: InstallationLookupEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private async getDb(): Promise<WorkerDb> {
    if (!this.db) {
      if (!this.env.HYPERDRIVE) {
        throw new Error('Hyperdrive not configured');
      }
      const { getWorkerDb } = await import('@kilocode/db/client');
      this.db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    }
    return this.db;
  }

  /**
   * Find a GitHub App installation ID for a given repo owner and user/org context.
   *
   * SECURITY: When looking up org installations, we JOIN with organization_memberships
   * to verify the user is actually a member of the organization. This prevents users
   * from accessing installations for orgs they don't belong to.
   *
   * Prioritizes org installations over user installations.
   */
  async findInstallationId(params: LookupParams): Promise<LookupResult> {
    if (!this.isConfigured()) {
      return null;
    }

    const [repoOwner] = params.githubRepo.split('/');

    const db = await this.getDb();

    const rows = await db
      .select({
        platform_installation_id: platform_integrations.platform_installation_id,
        platform_account_login: platform_integrations.platform_account_login,
        github_app_type: platform_integrations.github_app_type,
      })
      .from(platform_integrations)
      // For org installations, verify user is a member of the org
      .leftJoin(
        organization_memberships,
        and(
          eq(
            platform_integrations.owned_by_organization_id,
            organization_memberships.organization_id
          ),
          eq(organization_memberships.kilo_user_id, params.userId)
        )
      )
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.integration_type, 'app'),
          eq(platform_integrations.integration_status, 'active'),
          eq(platform_integrations.platform_account_login, repoOwner),
          isNotNull(platform_integrations.platform_installation_id),
          isNotNull(platform_integrations.platform_account_login),
          or(
            // Org installation: must match org ID AND user must be a member
            and(
              isNotNull(platform_integrations.owned_by_organization_id),
              eq(
                platform_integrations.owned_by_organization_id,
                sql`${params.orgId ?? null}::uuid`
              ),
              isNotNull(organization_memberships.id)
            ),
            // User installation: must match user ID directly
            and(
              isNotNull(platform_integrations.owned_by_user_id),
              eq(platform_integrations.owned_by_user_id, params.userId)
            )
          )
        )
      )
      .orderBy(
        sql`CASE WHEN ${platform_integrations.owned_by_organization_id} IS NOT NULL THEN 0 ELSE 1 END`
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      installationId: row.platform_installation_id ?? '',
      accountLogin: row.platform_account_login ?? '',
      githubAppType: row.github_app_type ?? 'standard',
    };
  }
}
