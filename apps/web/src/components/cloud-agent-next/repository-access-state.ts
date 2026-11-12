import type { RepositoryAccessMode } from '@kilocode/worker-utils/workspace-repository-access';
export function repositoryAccessTransition(
  current: RepositoryAccessMode | undefined,
  next: RepositoryAccessMode | 'remove'
) {
  if (next === 'remove') return 'remove';
  if (current === next) return 'unchanged';
  if (!current) return 'add';
  return next === 'read' ? 'reduce' : 'increase';
}
export function repositoryAccessResultMessage(changed: boolean): string {
  return changed
    ? 'Access updated. Retry the operation in this workspace.'
    : 'Repository access changed in another chat. Review the current list and retry.';
}
export function repositoryAccessErrorMessage(error?: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('repository_limit_reached'))
    return 'This workspace has reached the limit of 64 repositories. Remove access before adding another repository.';
  if (message.includes('repository_read_only'))
    return 'GitHub permits Read access only. Choose Read or check repository permissions.';
  if (message.includes('repository_access_required'))
    return 'This repository is not available through your connected GitHub accounts. Check the connection and retry.';
  if (message.includes('operation_not_supported'))
    return 'This operation is not supported by repository access.';
  if (message.includes('authorization_unavailable'))
    return 'GitHub authorization is unavailable. Retry, or reconnect GitHub if access has expired.';
  return 'Repository access could not be updated. Check your GitHub connection and retry.';
}
