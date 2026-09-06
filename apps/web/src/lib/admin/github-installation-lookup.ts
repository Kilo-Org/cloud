import 'server-only';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import {
  getGitHubAppCredentials,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/app-selector';
import * as z from 'zod';

const APP_TYPES = ['standard', 'lite'] as const;
const MAX_RECORDS = 100;
const REQUEST_TIMEOUT_MS = 8_000;

const InstallationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.string().min(1),
  }),
  suspended_at: z.string().nullable(),
  repository_selection: z.string().min(1),
});

type LookupReason =
  | 'not_found_for_app'
  | 'app_not_configured'
  | 'authentication_failed'
  | 'request_timeout'
  | 'upstream_error'
  | 'malformed_response';

export type GitHubOrganizationInstallationLookupResult = {
  organization: string;
  checkedAt: string;
  apps: Array<{
    appType: GitHubAppType;
    status: 'installed' | 'not_found' | 'unknown';
    reason?: LookupReason | 'suspended';
    installation?: {
      id: string;
      accountId: string;
      accountLogin: string;
      accountType: string;
      suspendedAt: string | null;
      repositorySelection: string;
    };
  }>;
  records: Array<{
    id: string;
    appType: string | null;
    installationId: string | null;
    accountLogin: string | null;
    accountId: string | null;
    status: string | null;
    suspendedAt: string | null;
    authInvalid: boolean;
    updatedAt: string;
    owner: { type: 'user' | 'organization'; id: string; name: string | null } | null;
    association: 'actual' | 'candidate';
  }>;
  recordsTruncated: boolean;
};

type LocalRecord = GitHubOrganizationInstallationLookupResult['records'][number];

type Dependencies = {
  getInstallation: (
    appType: GitHubAppType,
    organization: string
  ) => Promise<GitHubOrganizationInstallationLookupResult['apps'][number]>;
  findRecords: (input: {
    organization: string;
    installationIds: string[];
    accountIds: string[];
  }) => Promise<{ records: LocalRecord[]; recordsTruncated: boolean }>;
  now: () => Date;
};

function toIso(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function getGitHubAppConfig(appType: GitHubAppType) {
  try {
    const credentials = getGitHubAppCredentials(appType);
    return credentials.appId && credentials.privateKey
      ? { appId: credentials.appId, privateKey: credentials.privateKey }
      : null;
  } catch {
    return null;
  }
}

function reasonForError(error: unknown): LookupReason {
  if (error instanceof DOMException && error.name === 'AbortError') return 'request_timeout';
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = error.status;
    if (status === 401 || status === 403) return 'authentication_failed';
  }
  return 'upstream_error';
}

export async function lookupGitHubOrganizationInstallationForApp(
  appType: GitHubAppType,
  organization: string
): Promise<GitHubOrganizationInstallationLookupResult['apps'][number]> {
  const config = getGitHubAppConfig(appType);
  if (!config) return { appType, status: 'unknown', reason: 'app_not_configured' };

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const auth = createAppAuth(config);
    const { token } = await auth({ type: 'app' });
    const octokit = new Octokit({
      auth: token,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const response = await octokit.request('GET /orgs/{org}/installation', {
      org: organization,
      request: { signal: controller.signal },
    });
    const parsed = InstallationSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.account.type !== 'Organization') {
      return { appType, status: 'unknown', reason: 'malformed_response' };
    }
    const installation = parsed.data;
    return {
      appType,
      status: 'installed',
      ...(installation.suspended_at ? { reason: 'suspended' as const } : {}),
      installation: {
        id: installation.id.toString(),
        accountId: installation.account.id.toString(),
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        suspendedAt: toIso(installation.suspended_at),
        repositorySelection: installation.repository_selection,
      },
    };
  } catch (error) {
    if (timedOut) return { appType, status: 'unknown', reason: 'request_timeout' };
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      return { appType, status: 'not_found', reason: 'not_found_for_app' };
    }
    return { appType, status: 'unknown', reason: reasonForError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function findGitHubOrganizationInstallationRecords(input: {
  organization: string;
  installationIds: string[];
  accountIds: string[];
}): Promise<{ records: LocalRecord[]; recordsTruncated: boolean }> {
  const matchConditions = [ilike(platform_integrations.platform_account_login, input.organization)];
  if (input.installationIds.length > 0) {
    matchConditions.push(
      inArray(platform_integrations.platform_installation_id, input.installationIds)
    );
  }
  if (input.accountIds.length > 0) {
    matchConditions.push(inArray(platform_integrations.platform_account_id, input.accountIds));
  }

  const rows = await db
    .select({
      id: platform_integrations.id,
      appType: platform_integrations.github_app_type,
      installationId: platform_integrations.platform_installation_id,
      accountLogin: platform_integrations.platform_account_login,
      accountId: platform_integrations.platform_account_id,
      status: platform_integrations.integration_status,
      suspendedAt: platform_integrations.suspended_at,
      authInvalidAt: platform_integrations.auth_invalid_at,
      updatedAt: platform_integrations.updated_at,
      userId: kilocode_users.id,
      userName: kilocode_users.google_user_name,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(platform_integrations)
    .leftJoin(kilocode_users, eq(platform_integrations.owned_by_user_id, kilocode_users.id))
    .leftJoin(organizations, eq(platform_integrations.owned_by_organization_id, organizations.id))
    .where(and(eq(platform_integrations.platform, 'github'), or(...matchConditions)))
    .orderBy(asc(platform_integrations.id))
    .limit(MAX_RECORDS + 1);

  return {
    records: rows.slice(0, MAX_RECORDS).map(row => ({
      id: row.id,
      appType: row.appType,
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountId: row.accountId,
      status: row.status,
      suspendedAt: toIso(row.suspendedAt),
      authInvalid: row.authInvalidAt !== null,
      updatedAt: new Date(row.updatedAt).toISOString(),
      owner: row.userId
        ? { type: 'user', id: row.userId, name: row.userName }
        : row.organizationId
          ? { type: 'organization', id: row.organizationId, name: row.organizationName }
          : null,
      association: 'candidate',
    })),
    recordsTruncated: rows.length > MAX_RECORDS,
  };
}

const defaultDependencies: Dependencies = {
  getInstallation: lookupGitHubOrganizationInstallationForApp,
  findRecords: findGitHubOrganizationInstallationRecords,
  now: () => new Date(),
};

export async function lookupGitHubOrganizationInstallation(
  organization: string,
  dependencies: Dependencies = defaultDependencies
): Promise<GitHubOrganizationInstallationLookupResult> {
  const apps = await Promise.all(
    APP_TYPES.map(appType => dependencies.getInstallation(appType, organization))
  );
  const installations = apps.flatMap(app => (app.installation ? [app.installation] : []));
  const local = await dependencies.findRecords({
    organization,
    installationIds: installations.map(installation => installation.id),
    accountIds: installations.map(installation => installation.accountId),
  });
  const records: LocalRecord[] = local.records.map(record => {
    const liveInstallation = apps.find(
      app =>
        app.installation &&
        app.appType === (record.appType ?? 'standard') &&
        app.installation.id === record.installationId &&
        app.installation.accountId === record.accountId
    )?.installation;
    return {
      ...record,
      association: liveInstallation ? ('actual' as const) : ('candidate' as const),
    };
  });

  return {
    organization,
    checkedAt: dependencies.now().toISOString(),
    apps,
    records,
    recordsTruncated: local.recordsTruncated,
  };
}
