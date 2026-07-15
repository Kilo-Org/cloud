export function shouldShowRepositoryError({
  isError,
  repositoryCount,
}: {
  isError: boolean;
  repositoryCount: number;
}): boolean {
  return isError && repositoryCount === 0;
}
