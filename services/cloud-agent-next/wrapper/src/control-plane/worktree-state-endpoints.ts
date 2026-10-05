import type { WorktreeStateEndpoint } from '../worktree-state.js';

/**
 * The worktree-state endpoint arrives with `session.prepare`, but the capture
 * runs after every turn, so it is remembered per worktree directory.
 *
 * An omitted endpoint never clears a remembered grant: an omission is not an
 * authoritative revocation. The control plane omits the grant on any minting
 * failure (unset `WORKER_URL`, transient signing-secret lookup, unparseable
 * identity), and the grant is only redelivered with another `session.prepare`,
 * so clearing on omission would silently disable capture for the rest of the
 * sandbox lifetime. The entry is dropped explicitly when the worktree is
 * deleted (`forgetWorktreeStateEndpoint`) or superseded by a fresh grant.
 */
const endpoints = new Map<string, WorktreeStateEndpoint>();
/**
 * Directories whose destructive deletion is in flight. Capture is suppressed
 * (not forgotten) for the duration: the deletion aborts Kilo sessions, and a
 * capture that starts on the resulting cancelled turn must not upload a bundle
 * that outlives the discard. The endpoint and any stored bundle survive until
 * removal is confirmed, so a failed deletion leaves capture working.
 */
const deleting = new Set<string>();

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

export function beginWorktreeStateDeletion(directory: string): void {
  deleting.add(directory);
}

export function endWorktreeStateDeletion(directory: string): void {
  deleting.delete(directory);
}

export function isWorktreeStateDeletionInProgress(directory: string | undefined): boolean {
  return directory ? deleting.has(directory) : false;
}

export function forgetWorktreeStateEndpoint(directory: string): void {
  endpoints.delete(directory);
}

export function resetWorktreeStateEndpoints(): void {
  endpoints.clear();
  deleting.clear();
}
