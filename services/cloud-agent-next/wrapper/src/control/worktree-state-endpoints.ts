import type { WorktreeStateEndpoint } from '../worktree-state.js';

/**
 * The worktree-state endpoint arrives with `session.attach`, but the capture
 * runs after every turn, so it is remembered per worktree directory the same
 * way attached roots are.
 *
 * An omitted endpoint never clears a remembered grant: an omission is not an
 * authoritative revocation. The control plane omits the grant on any minting
 * failure (unset `WORKER_URL`, transient signing-secret lookup, unparseable
 * identity), and for a contained session the attach is dispatched at most once
 * per wrapper instance, so a later readiness pass never redelivers the grant.
 * Clearing on omission would silently disable capture for the rest of the
 * sandbox lifetime. The entry is dropped explicitly when the worktree is
 * deleted (`forgetWorktreeStateEndpoint`) or superseded by a fresh grant.
 */
const endpoints = new Map<string, WorktreeStateEndpoint>();

export function rememberWorktreeStateEndpoint(
  directory: string,
  endpoint: WorktreeStateEndpoint | undefined
): void {
  if (!endpoint) {
    return;
  }
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
