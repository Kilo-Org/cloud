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

const InstallationLookupResultSchema = z.object({
  platform_installation_id: z.string(),
  platform_account_login: z.string().nullable(),
  github_app_type: z.enum(['standard', 'lite']).nullable().optional(),
  owned_by_organization_id: z.string().nullable(),
});

const InstallationRefreshCandidateSchema = InstallationLookupResultSchema.extend({
  id: z.string(),
});

const ManagedInstallationLookupResultSchema = InstallationLookupResultSchema.extend({
  repository_access: z.string().nullable(),
  repositories: z
    .array(
      z.object({
        full_name: z.string(),
      })
    )
    .nullable(),
  permissions: z.record(z.string(), z.unknown()).nullable(),
});

const MAX_INSTALLATION_LOGIN_REFRESH_CANDIDATES = 10;

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
    | 'ambiguous_installation'
    | 'invalid_org_id';
};

export type InstallationLookupResult = InstallationLookupSuccess | InstallationLookupFailure;

export type InstallationRefreshCandidate = {
  integrationId: string;
  installationId: string;
  accountLogin: string | null;
  githubAppType: 'standard' | 'lite';
};

export type InstallationRefreshCandidatesResult =
  | { success: true; candidates: InstallationRefreshCandidate[] }
  | InstallationLookupFailure;

export type ManagedInstallationLookupSuccess = InstallationLookupSuccess & {
  repoName: string;
  permissions: Record<string, unknown> | null;
};

export type ManagedInstallationLookupResult =
  | ManagedInstallationLookupSuccess
  | InstallationLookupFailure
  | { success: false; reason: 'repository_not_installed' };

function buildAuthorizedInstallationsQuery(
  db: WorkerDb,
  params: FindInstallationParams,
  repoOwner?: string
) {
  const accountLoginFilter =
    repoOwner === undefined
      ? undefined
      : sql`lower(${platform_integrations.platform_account_login}) = lower(${repoOwner})`;

  return db
    .select({
      id: platform_integrations.id,
      platform_installation_id: platform_integrations.platform_installation_id,
      platform_account_login: platform_integrations.platform_account_login,
      github_app_type: platform_integrations.github_app_type,
      owned_by_organization_id: platform_integrations.owned_by_organization_id,
      repository_access: platform_integrations.repository_access,
      repositories: platform_integrations.repositories,
      permissions: platform_integrations.permissions,
    })
    .from(platform_integrations)
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
    .innerJoin(
      kilocode_users,
      and(eq(kilocode_users.id, params.userId), isNull(kilocode_users.blocked_reason))
    )
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_type, 'app'),
        eq(platform_integrations.integration_status, 'active'),
        accountLoginFilter,
        isNotNull(platform_integrations.platform_installation_id),
        or(
          and(
            isNotNull(platform_integrations.owned_by_organization_id),
            eq(platform_integrations.owned_by_organization_id, sql`${params.orgId ?? null}::uuid`),
            isNotNull(organization_memberships.id)
          ),
          and(
            isNotNull(platform_integrations.owned_by_user_id),
            eq(platform_integrations.owned_by_user_id, params.userId)
          )
        )
      )
    )
    .orderBy(
      sql`CASE WHEN ${platform_integrations.owned_by_organization_id} IS NOT NULL THEN 0 ELSE 1 END`
    );
}

export function buildInstallationLookupQuery(db: WorkerDb, params: FindInstallationParams) {
  const [repoOwner = ''] = params.githubRepo.split('/');
  return buildAuthorizedInstallationsQuery(db, params, repoOwner).limit(2);
}

export function buildInstallationRefreshCandidatesQuery(
  db: WorkerDb,
  params: FindInstallationParams
) {
  return buildAuthorizedInstallationsQuery(db, params).limit(
    MAX_INSTALLATION_LOGIN_REFRESH_CANDIDATES
  );
}

export function buildManagedInstallationLookupQuery(db: WorkerDb, params: FindInstallationParams) {
  const [repoOwner = ''] = params.githubRepo.split('/');
  return buildAuthorizedInstallationsQuery(db, params, repoOwner).limit(2);
}

export class InstallationLookupService {
  constructor(private env: CloudflareEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private getDb() {
    if (!this.env.HYPERDRIVE) {
      throw new Error('Hyperdrive not configured');
    }
    return getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  }

  private validateParams(params: FindInstallationParams): InstallationLookupFailure | null {
    if (!this.isConfigured()) {
      return { success: false, reason: 'database_not_configured' };
    }

    if (params.orgId !== undefined && !z.string().uuid().safeParse(params.orgId).success) {
      return { success: false, reason: 'invalid_org_id' };
    }

    const repoParts = params.githubRepo.split('/');
    if (repoParts.length !== 2 || repoParts.some(part => part.length === 0)) {
      return { success: false, reason: 'invalid_repo_format' };
    }

    return null;
  }

  async findInstallationId(params: FindInstallationParams): Promise<InstallationLookupResult> {
    const validationFailure = this.validateParams(params);
    if (validationFailure) {
      return validationFailure;
    }

    const rows = await buildInstallationLookupQuery(this.getDb(), params);

    if (rows.length === 0) {
      return { success: false, reason: 'no_installation_found' };
    }

    const [selected, other] = rows.map(row => InstallationLookupResultSchema.parse(row));
    if (!selected) {
      return { success: false, reason: 'no_installation_found' };
    }

    if (other) {
      console.warn(
        JSON.stringify({
          message: 'Multiple exact GitHub App integrations found during token resolution',
        })
      );
      return { success: false, reason: 'ambiguous_installation' };
    }

    return {
      success: true,
      installationId: selected.platform_installation_id,
      accountLogin: selected.platform_account_login ?? '',
      githubAppType: selected.github_app_type ?? 'standard',
    };
  }

  async findRefreshCandidates(
    params: FindInstallationParams
  ): Promise<InstallationRefreshCandidatesResult> {
    const validationFailure = this.validateParams(params);
    if (validationFailure) {
      return validationFailure;
    }

    const rows = await buildInstallationRefreshCandidatesQuery(this.getDb(), params);
    return {
      success: true,
      candidates: rows.map(row => {
        const parsed = InstallationRefreshCandidateSchema.parse(row);
        return {
          integrationId: parsed.id,
          installationId: parsed.platform_installation_id,
          accountLogin: parsed.platform_account_login,
          githubAppType: parsed.github_app_type ?? 'standard',
        };
      }),
    };
  }

  async updateAccountLogin(integrationId: string, accountLogin: string): Promise<boolean> {
    const updatedRows = await this.getDb()
      .update(platform_integrations)
      .set({
        platform_account_login: accountLogin,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integrationId))
      .returning({ id: platform_integrations.id });

    return updatedRows.length > 0;
  }

  async findManagedInstallationForRepo(
    params: FindInstallationParams
  ): Promise<ManagedInstallationLookupResult> {
    const validationFailure = this.validateParams(params);
    if (validationFailure) {
      return validationFailure;
    }

    const [, repoName] = params.githubRepo.split('/');
    if (!repoName) {
      return { success: false, reason: 'invalid_repo_format' };
    }

    const rows = await buildManagedInstallationLookupQuery(this.getDb(), params);
    if (rows.length === 0) {
      return { success: false, reason: 'no_installation_found' };
    }

    const [selected, other] = rows.map(row => ManagedInstallationLookupResultSchema.parse(row));
    if (!selected) {
      return { success: false, reason: 'no_installation_found' };
    }

    if (other) {
      console.warn(
        JSON.stringify({
          message: 'Multiple exact GitHub App integrations found during managed token resolution',
        })
      );
      return { success: false, reason: 'ambiguous_installation' };
    }

    if (
      selected.repository_access === 'selected' &&
      !selected.repositories?.some(repository => {
        const [storedOwner, storedRepoName, ...unexpectedParts] = repository.full_name.split('/');
        return (
          storedOwner !== undefined &&
          storedOwner.length > 0 &&
          storedRepoName?.toLowerCase() === repoName.toLowerCase() &&
          unexpectedParts.length === 0
        );
      })
    ) {
      return { success: false, reason: 'repository_not_installed' };
    }

    return {
      success: true,
      installationId: selected.platform_installation_id,
      accountLogin: selected.platform_account_login ?? '',
      githubAppType: selected.github_app_type ?? 'standard',
      repoName,
      permissions: selected.permissions,
    };
  }
}
