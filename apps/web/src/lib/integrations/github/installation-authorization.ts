import 'server-only';

import { Octokit } from '@octokit/rest';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';

export type GitHubInstallationCandidate = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User';
};

export type GitHubOAuthIdentity = {
  id: string;
  login: string;
};

type GitHubInstallationAuthorizationClient = {
  rest: {
    users: { getAuthenticated: () => Promise<{ data: { id: number; login: string } }> };
    orgs: {
      listMembershipsForAuthenticatedUser: (input: {
        page: number;
        per_page: number;
        state: 'active';
      }) => Promise<{
        data: Array<{
          state: string;
          role: string;
          organization: { id: number; login: string };
        }>;
      }>;
    };
    apps: {
      listInstallationsForAuthenticatedUser: (input: {
        page: number;
        per_page: number;
      }) => Promise<{
        data: {
          installations: Array<{
            id: number;
            app_id?: number | null;
            account?: { id?: number | null; login?: string | null; type?: string | null } | null;
          }>;
        };
      }>;
    };
  };
};

type GitHubInstallationPageItem = {
  id: number;
  appId: number | null;
  account: { id: number | null; login: string | null; type: string | null } | null;
};

function isOrganizationAccountType(value: string | null | undefined): value is 'Organization' {
  return value === 'Organization';
}

async function allPages<T>(fetchPage: (page: number) => Promise<T[]>) {
  const values: T[] = [];
  for (let page = 1; ; page += 1) {
    const current = await fetchPage(page);
    values.push(...current);
    if (current.length < 100) return values;
  }
}

export async function discoverAuthorizedGitHubInstallations(params: {
  accessToken: string;
  githubAppType: GitHubAppType;
  expectedAppId: string;
}): Promise<{ identity: GitHubOAuthIdentity; candidates: GitHubInstallationCandidate[] }> {
  const client: GitHubInstallationAuthorizationClient = new Octokit({ auth: params.accessToken });
  const expectedAppId = Number(params.expectedAppId);
  if (!Number.isSafeInteger(expectedAppId) || expectedAppId <= 0) {
    throw new Error(`GitHub ${params.githubAppType} App credentials not configured`);
  }

  const [{ data: user }, memberships, installations] = await Promise.all([
    client.rest.users.getAuthenticated(),
    allPages(
      async page =>
        (
          await client.rest.orgs.listMembershipsForAuthenticatedUser({
            page,
            per_page: 100,
            state: 'active',
          })
        ).data
    ),
    allPages<GitHubInstallationPageItem>(async page => {
      const { data } = await client.rest.apps.listInstallationsForAuthenticatedUser({
        page,
        per_page: 100,
      });
      return data.installations.map(installation => ({
        id: installation.id,
        appId: installation.app_id ?? null,
        account: installation.account
          ? {
              id: installation.account.id ?? null,
              login: installation.account.login ?? null,
              type: installation.account.type ?? null,
            }
          : null,
      }));
    }),
  ]);

  const activeOwnerAccountIds = new Set(
    memberships
      .filter(membership => membership.state === 'active' && membership.role === 'admin')
      .map(membership => membership.organization.id.toString())
  );

  const candidates = installations.flatMap<GitHubInstallationCandidate>(installation => {
    const account = installation.account;
    if (installation.appId !== expectedAppId || !account?.id || !account.login) {
      return [];
    }
    const accountId = account.id.toString();
    if (isOrganizationAccountType(account.type) && activeOwnerAccountIds.has(accountId)) {
      return [
        {
          installationId: installation.id.toString(),
          accountId,
          accountLogin: account.login,
          accountType: 'Organization' as const,
        },
      ];
    }
    if (account.type === 'User' && accountId === user.id.toString()) {
      return [
        {
          installationId: installation.id.toString(),
          accountId,
          accountLogin: account.login,
          accountType: 'User' as const,
        },
      ];
    }
    return [];
  });

  return { identity: { id: user.id.toString(), login: user.login }, candidates };
}

export async function verifyGitHubInstallationAuthorization(params: {
  accessToken: string;
  githubAppType: GitHubAppType;
  expectedAppId: string;
  installationId: string;
  accountId?: string;
  accountType?: 'Organization' | 'User';
}): Promise<{ identity: GitHubOAuthIdentity; candidate: GitHubInstallationCandidate } | null> {
  const discovered = await discoverAuthorizedGitHubInstallations(params);
  const candidate = discovered.candidates.find(
    value =>
      value.installationId === params.installationId &&
      (!params.accountId || value.accountId === params.accountId) &&
      (!params.accountType || value.accountType === params.accountType)
  );
  return candidate ? { identity: discovered.identity, candidate } : null;
}
