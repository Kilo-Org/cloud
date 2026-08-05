export type RepositorySectionView =
  | 'loading'
  | 'error'
  | 'connect'
  | 'connect-fallback'
  | 'connected-empty'
  | 'repos';

export function resolveRepositorySectionView({
  isLoading,
  isError,
  integrationInstalled,
  repositoryCount,
  connectCheckFailed,
}: {
  isLoading: boolean;
  isError: boolean;
  integrationInstalled: boolean | undefined;
  repositoryCount: number;
  connectCheckFailed: boolean;
}): RepositorySectionView {
  if (isLoading) {
    return 'loading';
  }
  if (isError && repositoryCount === 0) {
    return 'error';
  }
  if (connectCheckFailed) {
    return 'connect-fallback';
  }
  if (integrationInstalled === false) {
    return 'connect';
  }
  if (integrationInstalled === true && repositoryCount === 0) {
    return 'connected-empty';
  }
  return 'repos';
}

export function shouldShowRepositoryError({
  isError,
  repositoryCount,
}: {
  isError: boolean;
  repositoryCount: number;
}): boolean {
  return isError && repositoryCount === 0;
}
