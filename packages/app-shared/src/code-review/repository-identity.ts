import { z } from 'zod';
import type { CodeReviewPlatform } from './enums';

// Kilo ownership, not the provider's repository namespace.
export type Owner = { type: 'user'; id: string } | { type: 'org'; id: string };

// These values come from an authorized server lookup, never from a pasted URL alone.
export type RepositoryIdentity = {
  instanceUrl: string;
  repositoryId: string;
  fullName: string;
  defaultBranch: string | null;
} & (
  | { provider: Exclude<CodeReviewPlatform, 'bitbucket'>; workspaceUuid?: never }
  | { provider: 'bitbucket'; workspaceUuid: string }
);

export type OwnerIntegrationAuthorization = {
  kind: 'ownerIntegration';
  owner: Owner;
  integrationId: string;
};

export type GitHubUserAuthorization = {
  kind: 'githubUser';
  accountId: string;
  authorizationId: string;
};

export type RepositoryAuthorization = OwnerIntegrationAuthorization | GitHubUserAuthorization;
export type LaunchRepositoryReference = {
  repository: RepositoryIdentity;
  authorization: OwnerIntegrationAuthorization;
};
export type GitHubReviewRepositoryReference = {
  repository: RepositoryIdentity & { provider: 'github' };
  authorization: GitHubUserAuthorization;
};
export type RepositoryReference = LaunchRepositoryReference | GitHubReviewRepositoryReference;

export function requireLaunchRepository(reference: RepositoryReference): LaunchRepositoryReference {
  if (reference.authorization.kind !== 'ownerIntegration') {
    throw new Error('Launch requires ownerIntegration authorization');
  }
  return { repository: reference.repository, authorization: reference.authorization };
}

// Normalize URL syntax, excluding credentials, queries, and fragments. This does not authorize a host.
const instanceUrlSchema = z
  .url({ protocol: /^https$/, normalize: true })
  .regex(/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/);

// JSON tuples encode components without delimiter collisions. This namespace does
// not replace the legacy GitHub ledger keys or intent-fingerprint bytes.
export function repositoryResourceKey(accountId: string, reference: RepositoryReference): string {
  const { repository, authorization } = reference;
  if (authorization.kind === 'githubUser' && authorization.accountId !== accountId) {
    throw new Error('GitHub authorization belongs to another account');
  }
  return JSON.stringify([
    'provider-repository:v1',
    accountId,
    authorization.kind === 'ownerIntegration'
      ? [
          authorization.kind,
          authorization.owner.type,
          authorization.owner.id,
          authorization.integrationId,
        ]
      : [authorization.kind, authorization.accountId, authorization.authorizationId],
    repository.provider,
    instanceUrlSchema.parse(repository.instanceUrl).replace(/\/+$/, ''),
    repository.provider === 'bitbucket' ? repository.workspaceUuid : null,
    repository.repositoryId,
    repository.provider === 'github' ? repository.fullName.toLowerCase() : repository.fullName,
  ]);
}

type LegacyGitHubRepository = {
  provider?: 'github';
  instanceUrl?: string;
  repositoryId?: string;
  fullName: string;
  defaultBranch?: string | null;
};

// Old GitHub records omit provider/instance/defaultBranch and sometimes repository ID.
// Remove this fallback only after old clients/records disappear and the 30-day ledger window expires.
// The caller supplies user authorization and the resolved repository ID; installations play no part.
export function normalizeLegacyGitHubReviewRepository(input: {
  accountId: string;
  repository: LegacyGitHubRepository;
  authorization: GitHubUserAuthorization | null;
}):
  | { kind: 'resolved'; reference: GitHubReviewRepositoryReference }
  | { kind: 'legacy-unresolved'; accountId: string; repository: LegacyGitHubRepository } {
  const { accountId, repository, authorization } = input;
  if (
    !authorization?.authorizationId ||
    authorization.accountId !== accountId ||
    !repository.repositoryId
  ) {
    return { kind: 'legacy-unresolved', accountId, repository };
  }
  return {
    kind: 'resolved',
    reference: {
      repository: {
        provider: repository.provider ?? 'github',
        instanceUrl: repository.instanceUrl ?? 'https://github.com',
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch ?? null,
      },
      authorization,
    },
  };
}
