import * as z from 'zod';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  organization_memberships,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';

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
  metadata: GitLabIntegrationMetadata;
};

type GitLabLookupSuccess = {
  success: true;
  integrationId: string;
  metadata: GitLabIntegrationMetadata;
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

type ParsedGitLabInstanceUrl = {
  origin: string;
  basePath: string;
  instanceUrl: string;
};

function parseSecureUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseGitLabInstanceUrl(instanceUrl: string): ParsedGitLabInstanceUrl | null {
  const parsed = parseSecureUrl(instanceUrl);
  if (!parsed) {
    return null;
  }

  const basePath = parsed.pathname.replace(/\/+$/, '');
  return {
    origin: parsed.origin,
    basePath,
    instanceUrl: `${parsed.origin}${basePath}`,
  };
}

export function isValidGitLabRepositoryUrl(repositoryUrl: string): boolean {
  const parsed = parseSecureUrl(repositoryUrl);
  return parsed !== null && parsed.pathname !== '/' && !parsed.pathname.endsWith('/');
}

export function matchGitLabRepositoryToIntegration(
  repositoryUrl: string,
  integration: AuthorizedGitLabIntegration
): GitLabRepositoryMatch | null {
  const repository = parseSecureUrl(repositoryUrl);
  const instance = parseGitLabInstanceUrl(
    integration.metadata.gitlab_instance_url || DEFAULT_GITLAB_INSTANCE_URL
  );

  if (!repository || !instance || repository.origin !== instance.origin) {
    return null;
  }

  if (repository.pathname === '/' || repository.pathname.endsWith('/')) {
    return null;
  }

  const repositoryPrefix = instance.basePath === '' ? '/' : `${instance.basePath}/`;
  if (!repository.pathname.startsWith(repositoryPrefix)) {
    return null;
  }

  const encodedProjectPath = repository.pathname.slice(repositoryPrefix.length).replace(/^\/+/, '');
  let projectPath: string;
  try {
    projectPath = decodeURIComponent(encodedProjectPath);
  } catch {
    return null;
  }

  if (projectPath.endsWith('.git')) {
    projectPath = projectPath.slice(0, -4);
  }

  const pathSegments = projectPath.split('/');
  if (
    pathSegments.length < 2 ||
    pathSegments.some(segment => segment === '') ||
    pathSegments.includes('-')
  ) {
    return null;
  }

  return {
    ...integration,
    instanceUrl: instance.instanceUrl,
    projectPath,
  };
}

export function buildAuthorizedGitLabIntegrationQuery(db: WorkerDb, params: GitLabLookupParams) {
  return db
    .select({
      id: platform_integrations.id,
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

export class GitLabLookupService {
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

  private validateLookup(params: GitLabLookupParams): GitLabLookupFailure | undefined {
    if (!this.isConfigured()) {
      return { success: false, reason: 'database_not_configured' };
    }

    if (params.orgId !== undefined && !z.string().uuid().safeParse(params.orgId).success) {
      return { success: false, reason: 'invalid_org_id' };
    }
  }

  async findGitLabIntegration(params: GitLabLookupParams): Promise<GitLabLookupResult> {
    const validationFailure = this.validateLookup(params);
    if (validationFailure) {
      return validationFailure;
    }

    const rows = await buildAuthorizedGitLabIntegrationQuery(this.getDb(), params).limit(1);
    if (rows.length === 0) {
      return { success: false, reason: 'no_integration_found' };
    }

    const row = rows[0];
    return {
      success: true,
      integrationId: row.id,
      metadata: GitLabMetadataSchema.parse(row.metadata ?? {}),
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
      integrations: rows.map(row => ({
        integrationId: row.id,
        metadata: GitLabMetadataSchema.parse(row.metadata ?? {}),
      })),
    };
  }
}
