type RefreshSessionRepositoriesInput = {
  refreshGitHubRepositories: () => Promise<void>;
  refreshGitLabRepositories: () => Promise<void>;
  refreshBitbucketRepositories?: () => Promise<void>;
};

export type BitbucketRepositoryRefreshStatus =
  | 'available'
  | 'not_connected'
  | 'workspace_selection_required'
  | 'reconnect_required'
  | 'insufficient_permissions'
  | 'temporarily_unavailable'
  | 'invalid_request';

export async function refreshSessionRepositories({
  refreshGitHubRepositories,
  refreshGitLabRepositories,
  refreshBitbucketRepositories,
}: RefreshSessionRepositoriesInput): Promise<void> {
  const refreshers = [refreshGitHubRepositories, refreshGitLabRepositories];
  if (refreshBitbucketRepositories) refreshers.push(refreshBitbucketRepositories);

  await Promise.all(refreshers.map(refresh => refresh()));
}

export function shouldIncludeBitbucketRepositoryRefresh(
  status: BitbucketRepositoryRefreshStatus | undefined
): boolean {
  return status === 'available' || status === 'temporarily_unavailable';
}

export function shouldCacheBitbucketRepositoryRefreshResult(
  status: BitbucketRepositoryRefreshStatus
): boolean {
  return status !== 'temporarily_unavailable';
}

export function getBitbucketRepositoryRefreshFailureMessage(
  status: Exclude<BitbucketRepositoryRefreshStatus, 'available'>
): string {
  if (status === 'temporarily_unavailable') {
    return 'Bitbucket is temporarily unavailable. Try again in a minute.';
  }

  return 'Bitbucket repositories are not available. Check the Bitbucket integration settings.';
}
