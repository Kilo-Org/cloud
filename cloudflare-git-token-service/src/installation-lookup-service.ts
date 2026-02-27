import * as z from 'zod';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  organization_memberships,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, and, isNull, isNotNull, or, sql } from 'drizzle-orm';

export type FindInstallationParams = {
  githubRepo: string;
  userId: string;
  orgId?: string;
};

const FindInstallationParamsSchema = z.object({
  githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  userId: z.string(),
  orgId: z.string().uuid().optional(),
});

export type InstallationLookupSuccess = {
  success: true;
  installationId: string;
  accountLogin: string;
  githubAppType: 'standard' | 'lite';
};

export type InstallationLookupFailure = {
  success: false;
  reason: 'database_not_configured' | 'invalid_params' | 'no_installation_found';
};

export type InstallationLookupResult = InstallationLookupSuccess | InstallationLookupFailure;

export class InstallationLookupService {
  private db: WorkerDb | null = null;

  constructor(private env: CloudflareEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private getDb(): WorkerDb {
    if (!this.db) {
      if (!this.env.HYPERDRIVE) {
        throw new Error('Hyperdrive not configured');
      }
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
  async findInstallationId(params: FindInstallationParams): Promise<InstallationLookupResult> {
    if (!this.isConfigured()) {
      return { success: false, reason: 'database_not_configured' };
    }

    const parsed = FindInstallationParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, reason: 'invalid_params' };
    }

    const { githubRepo, userId, orgId } = parsed.data;
    const [repoOwner] = githubRepo.split('/');

    const db = this.getDb();

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
          eq(organization_memberships.kilo_user_id, userId)
        )
      )
      // Verify user is not blocked
      .innerJoin(
        kilocode_users,
        and(eq(kilocode_users.id, userId), isNull(kilocode_users.blocked_reason))
      )
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.integration_type, 'app'),
          eq(platform_integrations.integration_status, 'active'),
          eq(platform_integrations.platform_account_login, repoOwner),
          or(
            // Org installation: must match org ID AND user must be a member
            and(
              isNotNull(platform_integrations.owned_by_organization_id),
              eq(platform_integrations.owned_by_organization_id, sql`${orgId ?? null}::uuid`),
              isNotNull(organization_memberships.id)
            ),
            // User installation: must match user ID directly
            and(
              isNotNull(platform_integrations.owned_by_user_id),
              eq(platform_integrations.owned_by_user_id, userId)
            )
          )
        )
      )
      .orderBy(
        sql`CASE WHEN ${platform_integrations.owned_by_organization_id} IS NOT NULL THEN 0 ELSE 1 END`
      )
      .limit(1);

    if (rows.length === 0) {
      return { success: false, reason: 'no_installation_found' };
    }

    const row = rows[0];
    if (!row?.platform_installation_id || !row.platform_account_login) {
      return { success: false, reason: 'no_installation_found' };
    }

    return {
      success: true,
      installationId: row.platform_installation_id,
      accountLogin: row.platform_account_login,
      githubAppType: row.github_app_type ?? 'standard',
    };
  }
}
