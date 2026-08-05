/**
 * App-install return-outcome store.
 *
 * When the callback redirects to /cloud/sessions?github_install=success the
 * universal link delivers the URL with query params to the app.  The deep-link
 * handler extracts the outcome and stores it here.  The agents tab reads it
 * on mount to show the four C13 plan states.
 *
 * An org-scoped install keeps `organizationId` on the outcome so a retryable
 * failure can re-mint the install state for the original organization owner.
 */

export type GitHubInstallReturnOutcome =
  | { kind: 'success'; organizationId?: string }
  | { kind: 'pending'; organizationId?: string }
  | { kind: 'error'; code: string; organizationId?: string }
  | null;

let outcome: GitHubInstallReturnOutcome = null;
const listeners = new Set<() => void>();

export function setGitHubInstallReturnOutcome(next: GitHubInstallReturnOutcome): void {
  outcome = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getGitHubInstallReturnOutcome(): GitHubInstallReturnOutcome {
  const current = outcome;
  outcome = null;
  return current;
}

/** Subscribe to outcomes delivered while the Agents tab is already focused. */
export function subscribeToGitHubInstallReturnOutcome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Extract C13 return outcome params from a raw URL query string. */
export function parseGitHubReturnParams(search: string): GitHubInstallReturnOutcome {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const organizationId = params.get('organizationId') ?? undefined;
  if (params.get('github_install') === 'success') {
    return { kind: 'success', ...(organizationId ? { organizationId } : {}) };
  }
  if (params.get('github_pending_approval') === 'true') {
    return { kind: 'pending', ...(organizationId ? { organizationId } : {}) };
  }
  const error = params.get('error');
  if (error) {
    return { kind: 'error', code: error, ...(organizationId ? { organizationId } : {}) };
  }
  return null;
}
