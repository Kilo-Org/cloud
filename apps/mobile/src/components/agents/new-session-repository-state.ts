export type RepositoryPlatform = 'github' | 'gitlab' | 'bitbucket';

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
