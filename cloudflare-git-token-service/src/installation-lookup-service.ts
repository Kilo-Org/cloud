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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

const InstallationLookupResultSchema = z.object({
  platform_installation_id: z.string(),
  platform_account_login: z.string(),
  github_app_type: z.enum(['standard', 'lite']).nullable().optional(),
});

export type InstallationLookupSuccess = {
  success: true;
  installationId: string;
  accountLogin: string;
  githubAppType: 'standard' | 'lite';
};

export type InstallationLookupFailure = {
  success: false;
  reason:
    | 'database_not_configured'
    | 'invalid_repo_format'
    | 'no_installation_found'
    | 'invalid_org_id';
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

    // Validate orgId is a valid UUID if provided, to prevent database errors
    if (params.orgId !== undefined && !isValidUuid(params.orgId)) {
      return { success: false, reason: 'invalid_org_id' };
    }

    // Validate githubRepo format (expected: "owner/repo")
    if (!params.githubRepo || !params.githubRepo.includes('/')) {
      return { success: false, reason: 'invalid_repo_format' };
    }

    const [repoOwner] = params.githubRepo.split('/');
    if (!repoOwner) {
      return { success: false, reason: 'invalid_repo_format' };
    }

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
          eq(organization_memberships.kilo_user_id, params.userId)
        )
      )
      // Verify user is not blocked
      .innerJoin(
        kilocode_users,
        and(eq(kilocode_users.id, params.userId), isNull(kilocode_users.blocked_reason))
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
      return { success: false, reason: 'no_installation_found' };
    }

    const parsed = InstallationLookupResultSchema.parse(rows[0]);
    return {
      success: true,
      installationId: parsed.platform_installation_id,
      accountLogin: parsed.platform_account_login,
      githubAppType: parsed.github_app_type ?? 'standard',
    };
  }
}
