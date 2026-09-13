import { type RepoPlatform } from '@/lib/picker-bridge';

export type RepositoryPlatform = RepoPlatform;

/**
 * One selectable repository row. `platform` is required so two rows with the
 * same `fullName` on different providers stay distinct in the picker and in
 * the create payload. `workspaceUuid`/`repositoryUuid` are only present on
 * Bitbucket rows (`repositoryUuid` = the Bitbucket repository `id`).
 */
export type NewSessionRepository = {
  platform: RepositoryPlatform;
  fullName: string;
  isPrivate: boolean;
  workspaceUuid?: string;
  repositoryUuid?: string;
};

export type RepositoryProviderStatus =
  | 'loading'
  | 'error'
  | 'connect'
  | 'connected-empty'
  | 'repos';

export type RepositoryGroup = {
  key: RepositoryPlatform;
  status: RepositoryProviderStatus;
  repositories: NewSessionRepository[];
};

export type RepositoryGroups = {
  /** Recently used rows, resolved against connected providers. */
  recents: NewSessionRepository[];
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
}: {
  isLoading: boolean;
  isError: boolean;
  integrationInstalled: boolean | undefined;
  repositoryCount: number;
}): RepositoryProviderStatus {
  if (isLoading) {
    return 'loading';
  }
  if (isError && repositoryCount === 0) {
    return 'error';
  }
  if (integrationInstalled === false) {
    return 'connect';
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
 *  - transient/invalid       -> error (retry)
 */
export function resolveBitbucketStatus({
  isLoading,
  isError,
  status,
  repositoryCount,
}: {
  isLoading: boolean;
  isError: boolean;
  status: string | undefined;
  repositoryCount: number;
}): RepositoryProviderStatus {
  if (isLoading) {
    return 'loading';
  }
  if (isError && repositoryCount === 0) {
    return 'error';
  }
  if (status === undefined) {
    return 'loading';
  }
  if (status === 'available') {
    return repositoryCount === 0 ? 'connected-empty' : 'repos';
  }
  if (status === 'temporarily_unavailable' || status === 'invalid_request') {
    return 'error';
  }
  // not_connected, workspace_selection_required, reconnect_required,
  // insufficient_permissions -> the user must (re)establish the connection.
  return 'connect';
}

// ── Dedup and grouping ───────────────────────────────────────────────

const repositoryKey = (repository: NewSessionRepository): string =>
  `${repository.platform}/${repository.fullName}`;

/**
 * Deduplicate repository rows by `platform + fullName`, so the same
 * `fullName` on two platforms stays two rows.
 */
export function dedupeRepositoriesByPlatformAndFullName(
  repositories: readonly NewSessionRepository[]
): NewSessionRepository[] {
  const seen = new Set<string>();
  const result: NewSessionRepository[] = [];
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
  recents: NewSessionRepository[];
}): RepositoryGroups {
  const groups: RepositoryGroup[] = [
    { key: 'github', status: input.github.status, repositories: input.github.repositories },
    { key: 'gitlab', status: input.gitlab.status, repositories: input.gitlab.repositories },
  ];
  if (input.organizationId) {
    groups.push({
      key: 'bitbucket',
      status: input.bitbucket.status,
      repositories: input.bitbucket.repositories,
    });
  }
  return { recents: input.recents, groups };
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

// ── Branch selection state ───────────────────────────────────────────

/**
 * The full identity of one repository row: provider, path, and (Bitbucket
 * only) the workspace/repository uuids. Two same-named rows on two providers,
 * or two same-named Bitbucket rows in renamed workspaces, never share a key,
 * so a branch chosen for one can never be read back for the other.
 */
export function repositoryIdentityKey(repository: NewSessionRepository): string {
  return [
    repository.platform,
    repository.fullName,
    repository.workspaceUuid ?? '',
    repository.repositoryUuid ?? '',
  ].join('\n');
}

/**
 * New-session branch state, shared by the repository section (which owns the
 * picker) and `useNewSessionCreator` (which sends the checkout branch).
 *
 * It is a module store rather than props because the two files between them —
 * `new-session-configure-form.tsx` and `new-session-screen-body.tsx` — are not
 * part of this change. The store holds nothing durable: the section clears it
 * on mount and on unmount, so a branch never outlives the screen that chose it.
 *
 * `overrides` only ever holds a *non-default* branch, keyed by
 * `repositoryIdentityKey`. Reading with another repository's key yields
 * `null` — that is the identity rule: a branch that belongs to one repository
 * can never survive a repository change onto another.
 *
 * `organizationId` is the new-session route's organization scope, published by
 * `useNewSessionRepos` (the hook the route already hands it to). `isScopeReady`
 * stays false until that first publish, so a branch query never runs against
 * the wrong scope — `undefined` is a real value (a personal session), not a
 * "not yet known".
 */
export type NewSessionBranchSnapshot = {
  isScopeReady: boolean;
  organizationId: string | undefined;
  overrides: ReadonlyMap<string, string>;
};

const EMPTY_OVERRIDES: ReadonlyMap<string, string> = new Map();

let branchSnapshot: NewSessionBranchSnapshot = {
  isScopeReady: false,
  organizationId: undefined,
  overrides: EMPTY_OVERRIDES,
};

const branchListeners = new Set<() => void>();

function publishBranchSnapshot(next: NewSessionBranchSnapshot): void {
  branchSnapshot = next;
  for (const listener of branchListeners) {
    listener();
  }
}

export function subscribeNewSessionBranchState(listener: () => void): () => void {
  branchListeners.add(listener);
  return () => {
    branchListeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` never loops. */
export function getNewSessionBranchState(): NewSessionBranchSnapshot {
  return branchSnapshot;
}

/** Publish the route's organization scope for the branch queries. */
export function setNewSessionBranchScope(organizationId: string | undefined): void {
  if (branchSnapshot.isScopeReady && branchSnapshot.organizationId === organizationId) {
    return;
  }
  publishBranchSnapshot({ ...branchSnapshot, isScopeReady: true, organizationId });
}

/**
 * Drop the published scope when the new-session screen goes away. Without
 * this, a remount reads the previous screen's organization on its first
 * render — before the publishing effect runs — and a branch query for the
 * already-selected repository fires against an organization the user has
 * left. Going back to "not ready" (rather than publishing a personal scope)
 * keeps both directions safe: the next screen's first render queries nothing
 * until its own scope is published.
 */
export function resetNewSessionBranchScope(): void {
  if (!branchSnapshot.isScopeReady) {
    return;
  }
  publishBranchSnapshot({ ...branchSnapshot, isScopeReady: false, organizationId: undefined });
}

/**
 * Record the branch override for one repository. `null` (the provider default
 * was chosen) drops the entry, so the create body carries no `upstreamBranch`
 * and the server checks out the provider's own default.
 */
export function setSelectedBranchOverride(
  repository: NewSessionRepository,
  branch: string | null
): void {
  const key = repositoryIdentityKey(repository);
  const current = branchSnapshot.overrides.get(key) ?? null;
  if (current === branch) {
    return;
  }
  const overrides = new Map(branchSnapshot.overrides);
  if (branch === null) {
    overrides.delete(key);
  } else {
    overrides.set(key, branch);
  }
  publishBranchSnapshot({ ...branchSnapshot, overrides });
}

/** The non-default branch chosen for exactly this repository, or `null`. */
export function getSelectedBranchOverride(repository: NewSessionRepository | null): string | null {
  if (!repository) {
    return null;
  }
  return branchSnapshot.overrides.get(repositoryIdentityKey(repository)) ?? null;
}

/** Drop every override (screen mount/unmount), keeping the published scope. */
export function resetSelectedBranchOverrides(): void {
  if (branchSnapshot.overrides.size === 0) {
    return;
  }
  publishBranchSnapshot({ ...branchSnapshot, overrides: EMPTY_OVERRIDES });
}
