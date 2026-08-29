import { type CodeReviewPlatform } from '@kilocode/app-shared/code-review';
import {
  type LaunchRepositoryReference,
  repositoryResourceKey,
} from '@kilocode/app-shared/code-review/repository-identity';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

export type RepositoryPlatform = CodeReviewPlatform;

export type NewSessionRepository = {
  platform: RepositoryPlatform;
  fullName: string;
  isPrivate: boolean;
  workspaceUuid?: string;
  repositoryUuid?: string;
  // Old creator callers omit identity. Remove this input form only after old
  // clients/records disappear and the 30-day ledger window expires.
  reference?: LaunchRepositoryReference;
  key?: string;
  accountId?: string;
  accountLogin?: string;
};

export type ResolvedNewSessionRepository = NewSessionRepository & {
  reference: LaunchRepositoryReference;
  key: string;
  accountId: string;
};

type RepositoryWire = Pick<
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['listGitHubRepositories']['repositories'][number],
  'private' | 'repositoryReference' | 'platformAccountLogin'
>;

export function normalizeSessionRepository(
  row: RepositoryWire,
  accountId: string | undefined,
  organizationId: string | undefined
): ResolvedNewSessionRepository | null {
  const reference = row.repositoryReference;
  // Old discovery responses without identity remain quarantined until refreshed.
  // Remove after old clients/records disappear and the 30-day ledger window expires.
  if (!reference || !accountId) {
    return null;
  }
  const { repository, authorization } = reference;
  if (
    authorization.owner.type !== (organizationId ? 'org' : 'user') ||
    authorization.owner.id !== (organizationId ?? accountId) ||
    (repository.provider === 'bitbucket' && !organizationId)
  ) {
    return null;
  }
  return {
    platform: repository.provider,
    fullName: repository.fullName,
    isPrivate: row.private,
    reference,
    accountId,
    key: repositoryResourceKey(accountId, reference),
    accountLogin: row.platformAccountLogin,
    ...(repository.provider === 'bitbucket'
      ? { workspaceUuid: repository.workspaceUuid, repositoryUuid: repository.repositoryId }
      : {}),
  };
}

export function repositoryKey(repository: ResolvedNewSessionRepository): string {
  return repository.key;
}

export function repositoryLabel(repository: NewSessionRepository): string {
  const reference = repository.reference;
  if (!reference) {
    return repository.fullName;
  }
  const { owner, integrationId } = reference.authorization;
  return [
    repository.fullName,
    repository.accountLogin,
    reference.repository.instanceUrl,
    `${owner.type}:${owner.id}`,
    integrationId,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type RepositoryProviderStatus =
  | 'loading'
  | 'error'
  | 'access-denied'
  | 'identity-unavailable'
  | 'connect'
  | 'connected-empty'
  | 'repos';

export type RepositoryGroup = {
  key: RepositoryPlatform;
  status: RepositoryProviderStatus;
  repositories: ResolvedNewSessionRepository[];
};

export type RepositoryGroups = {
  /** Recently used rows, resolved against connected providers. */
  recents: ResolvedNewSessionRepository[];
  /** Ordered groups: GitHub, GitLab, then Bitbucket (only when an organization is set). */
  groups: RepositoryGroup[];
};

// ── Per-provider status helpers ─────────────────────────────────────

/**
 * Resolve the status for a GitHub or GitLab group. They share the same
 * `{ repositories, integrationInstalled }` response shape.
 */
export function resolveProviderStatus({
  isLoading,
  isError,
  integrationInstalled,
  repositoryCount,
  errorCode,
  hasUnresolved = false,
}: {
  isLoading: boolean;
  isError: boolean;
  integrationInstalled: boolean | undefined;
  repositoryCount: number;
  errorCode?: string;
  hasUnresolved?: boolean;
}): RepositoryProviderStatus {
  if (errorCode === 'FORBIDDEN' || errorCode === 'BAD_REQUEST') {
    return 'access-denied';
  }
  if (
    errorCode === 'UNAUTHORIZED' ||
    errorCode === 'PRECONDITION_FAILED' ||
    integrationInstalled === false
  ) {
    return 'connect';
  }
  if (isLoading) {
    return 'loading';
  }
  if (isError) {
    return 'error';
  }
  if (hasUnresolved) {
    return 'identity-unavailable';
  }
  if (integrationInstalled === true && repositoryCount === 0) {
    return 'connected-empty';
  }
  return 'repos';
}

/**
 * Resolve the status for the organization-only Bitbucket group, whose
 * response is a discriminated union on `status` rather than a boolean
 * `integrationInstalled` flag.
 *
 *  - `available`             -> repos / connected-empty
 *  - connect-shaped statuses -> connect (open the Bitbucket settings page)
 *  - transient failure       -> error (retry)
 *  - invalid/denied          -> access-denied (correct access or selection)
 */
export function resolveBitbucketStatus({
  isLoading,
  isError,
  status,
  repositoryCount,
  errorCode,
  hasUnresolved = false,
}: {
  isLoading: boolean;
  isError: boolean;
  status: string | undefined;
  repositoryCount: number;
  errorCode?: string;
  hasUnresolved?: boolean;
}): RepositoryProviderStatus {
  if (
    errorCode === 'FORBIDDEN' ||
    status === 'insufficient_permissions' ||
    status === 'invalid_request'
  ) {
    return 'access-denied';
  }
  if (
    errorCode === 'UNAUTHORIZED' ||
    status === 'not_connected' ||
    status === 'workspace_selection_required' ||
    status === 'reconnect_required'
  ) {
    return 'connect';
  }
  if (isLoading) {
    return 'loading';
  }
  if (isError || status === 'temporarily_unavailable') {
    return 'error';
  }
  if (hasUnresolved) {
    return 'identity-unavailable';
  }
  if (status === undefined) {
    return 'loading';
  }
  if (status === 'available') {
    return repositoryCount === 0 ? 'connected-empty' : 'repos';
  }
  // not_connected, workspace_selection_required, reconnect_required:
  // the user must establish the connection.
  return 'connect';
}

// ── Dedup and grouping ───────────────────────────────────────────────

/** Keep the old export name; normalized discovery deduplicates by the complete identity. */
export function dedupeRepositoriesByPlatformAndFullName<T extends ResolvedNewSessionRepository>(
  repositories: readonly T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const repository of repositories) {
    const key = repositoryKey(repository);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(repository);
    }
  }
  return result;
}

/**
 * Assemble the ordered provider groups for the section. The Bitbucket group
 * is dropped when no organization is set (Bitbucket is organization-only).
 * Each group keeps its own status, so one provider's error never clears
 * another provider's rows.
 */
export function resolveRepositoryGroups(input: {
  organizationId: string | undefined;
  github: RepositoryGroup;
  gitlab: RepositoryGroup;
  bitbucket: RepositoryGroup;
  recents: ResolvedNewSessionRepository[];
}): RepositoryGroups {
  const groups = [
    input.github,
    input.gitlab,
    ...(input.organizationId ? [input.bitbucket] : []),
  ].map(group => ({
    key: group.key,
    status: group.status,
    repositories:
      group.status === 'connect' || group.status === 'access-denied' ? [] : group.repositories,
  }));
  const usableKeys = new Set(groups.flatMap(group => group.repositories.map(repo => repo.key)));
  return { recents: input.recents.filter(repo => usableKeys.has(repo.key)), groups };
}

/**
 * Detect the repository provider from a git URL host. Returns `undefined`
 * for unknown or self-hosted hosts (those recents are dropped because they
 * cannot be attributed to a connected provider).
 */
export function detectRepositoryPlatform(
  gitUrl: string | null | undefined
): RepositoryPlatform | undefined {
  if (!gitUrl) {
    return undefined;
  }
  let hostname: string | undefined = /^git@([^:]+):/.exec(gitUrl)?.[1];
  if (hostname === undefined) {
    try {
      hostname = new URL(gitUrl).hostname;
    } catch {
      return undefined;
    }
  }
  if (hostname === 'github.com') {
    return 'github';
  }
  if (hostname === 'gitlab.com') {
    return 'gitlab';
  }
  if (hostname === 'bitbucket.org') {
    return 'bitbucket';
  }
  return undefined;
}
