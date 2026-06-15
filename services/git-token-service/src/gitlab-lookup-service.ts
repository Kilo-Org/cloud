import * as z from 'zod';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  organization_memberships,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import { parseGitLabCloneUrl } from './gitlab-url.js';
export { isValidGitLabRepositoryUrl, normalizeGitLabInstanceUrl } from './gitlab-url.js';

export type GitLabLookupParams = {
  userId: string;
  orgId?: string;
};

export type GitLabIntegrationMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  client_id?: string;
  client_secret?: string;
  auth_type?: 'oauth' | 'pat';
  project_tokens?: Record<string, { token: string }>;
};

export type AuthorizedGitLabIntegration = {
  integrationId: string;
  integrationType: string;
  accountId: string | null;
  accountLogin: string | null;
  metadata: GitLabIntegrationMetadata;
};

export type GitLabLookupSuccess = AuthorizedGitLabIntegration & {
  success: true;
};

export type GitLabLookupFailure = {
  success: false;
  reason: 'database_not_configured' | 'no_integration_found' | 'invalid_org_id';
};

export type GitLabLookupResult = GitLabLookupSuccess | GitLabLookupFailure;

export type AuthorizedGitLabIntegrationsResult =
  | { success: true; integrations: AuthorizedGitLabIntegration[] }
  | GitLabLookupFailure;

export type GitLabRepositoryMatch = AuthorizedGitLabIntegration & {
  instanceUrl: string;
  projectPath: string;
};

const GitLabMetadataSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    token_expires_at: z.string().optional(),
    gitlab_instance_url: z.string().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    auth_type: z.enum(['oauth', 'pat']).optional(),
    project_tokens: z
      .record(z.string(), z.object({ token: z.string().min(1) }).passthrough())
      .optional(),
  })
  .passthrough();

export function matchGitLabRepositoryToIntegration(
  repositoryUrl: string,
  integration: AuthorizedGitLabIntegration
): GitLabRepositoryMatch | null {
  const repository = parseGitLabCloneUrl(
    repositoryUrl,
    integration.metadata.gitlab_instance_url || DEFAULT_GITLAB_INSTANCE_URL
  );
  if (!repository.success) return null;
  return {
    ...integration,
    instanceUrl: repository.instanceOrigin,
    projectPath: repository.projectPath,
  };
}

export function buildAuthorizedGitLabIntegrationQuery(
  db: WorkerDb,
  params: GitLabLookupParams,
  integrationId?: string
) {
  return db
    .select({
      id: platform_integrations.id,
      integration_type: platform_integrations.integration_type,
      platform_account_id: platform_integrations.platform_account_id,
      platform_account_login: platform_integrations.platform_account_login,
      metadata: platform_integrations.metadata,
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
        eq(platform_integrations.platform, 'gitlab'),
        eq(platform_integrations.integration_status, 'active'),
        ...(integrationId !== undefined ? [eq(platform_integrations.id, integrationId)] : []),
        params.orgId
          ? and(
              eq(platform_integrations.owned_by_organization_id, sql`${params.orgId}::uuid`),
              isNotNull(organization_memberships.id)
            )
          : and(
              isNotNull(platform_integrations.owned_by_user_id),
              eq(platform_integrations.owned_by_user_id, params.userId)
            )
      )
    );
}

function parseAuthorizedGitLabIntegration(row: {
  id: string;
  integration_type: string;
  platform_account_id: string | null;
  platform_account_login: string | null;
  metadata: unknown;
}): AuthorizedGitLabIntegration {
  return {
    integrationId: row.id,
    integrationType: row.integration_type,
    accountId: row.platform_account_id,
    accountLogin: row.platform_account_login,
    metadata: GitLabMetadataSchema.parse(row.metadata ?? {}),
  };
}

export class GitLabLookupService {
  constructor(private env: CloudflareEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private getDb(): WorkerDb {
    if (!this.env.HYPERDRIVE) {
      throw new Error('Hyperdrive not configured');
    }
    return getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  }

  private validateLookup(params: GitLabLookupParams): GitLabLookupFailure | undefined {
    if (!this.isConfigured()) {
      return { success: false, reason: 'database_not_configured' };
    }

    if (params.orgId !== undefined && !z.string().uuid().safeParse(params.orgId).success) {
      return { success: false, reason: 'invalid_org_id' };
    }
  }

  async findGitLabIntegration(
    params: GitLabLookupParams,
    integrationId?: string
  ): Promise<GitLabLookupResult> {
    const validationFailure = this.validateLookup(params);
    if (validationFailure) {
      return validationFailure;
    }

    const rows = await buildAuthorizedGitLabIntegrationQuery(
      this.getDb(),
      params,
      integrationId
    ).limit(1);
    if (rows.length === 0) {
      return { success: false, reason: 'no_integration_found' };
    }

    return {
      success: true,
      ...parseAuthorizedGitLabIntegration(rows[0]),
    };
  }

  async findAuthorizedGitLabIntegrations(
    params: GitLabLookupParams
  ): Promise<AuthorizedGitLabIntegrationsResult> {
    const validationFailure = this.validateLookup(params);
    if (validationFailure) {
      return validationFailure;
    }

    const rows = await buildAuthorizedGitLabIntegrationQuery(this.getDb(), params);
    if (rows.length === 0) {
      return { success: false, reason: 'no_integration_found' };
    }

    return {
      success: true,
      integrations: rows.map(parseAuthorizedGitLabIntegration),
    };
  }
}
