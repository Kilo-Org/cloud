import type { WorktreeStateEndpoint } from '../worktree-state.js';

/**
 * The worktree-state endpoint arrives with `session.attach`, but the capture
 * runs after every turn, so it is remembered per worktree directory the same
 * way attached roots are.
 */
const endpoints = new Map<string, WorktreeStateEndpoint>();

export function rememberWorktreeStateEndpoint(
  directory: string,
  endpoint: WorktreeStateEndpoint | undefined
): void {
  if (!endpoint) return;
  endpoints.set(directory, endpoint);
}

export function worktreeStateEndpointFor(
  directory: string | undefined
): WorktreeStateEndpoint | undefined {
  return directory ? endpoints.get(directory) : undefined;
}

export function forgetWorktreeStateEndpoint(directory: string): void {
  endpoints.delete(directory);
}

export function resetWorktreeStateEndpoints(): void {
  endpoints.clear();
}
