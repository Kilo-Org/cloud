import { isExpectedAuthFailure } from '@/lib/auth/trpc-unauthorized';

// Pure decision helpers for useGitHubReposRefresh, extracted so the test
// doesn't pull in react-native (Flow-syntax) via the hook module.

/**
 * Whether `connectCheckFailed` should be set after a return-triggered
 * force-fresh. Only set when the browser-return payload says
 * integration not installed. Manual Refresh / Check again never sets it.
 */
export function shouldSetConnectCheckFailed(params: {
  isReturnTriggered: boolean;
  integrationInstalled: boolean | undefined;
}): boolean {
  return params.isReturnTriggered && params.integrationInstalled === false;
}

/**
 * Whether `connectCheckFailed` should be cleared after a force-fresh.
 * Clears on any success showing installed, or via the input-installed
 * effect (handled separately in the hook).
 */
export function shouldClearConnectCheckFailed(params: {
  integrationInstalled: boolean | undefined;
}): boolean {
  return params.integrationInstalled === true;
}

/**
 * Whether a repository refresh shows its one failure toast. `failures` holds
 * the rejection of every provider that failed in the same refresh, so GitHub
 * and GitLab failing together still toast once. A refusal of the session
 * credential is the auth layer's to report: it refreshes the token or ends the
 * session with its own toast, so a refresh that failed only that way is silent.
 */
export function shouldToastRepositoryRefreshFailure(failures: readonly unknown[]): boolean {
  return failures.some(error => !isExpectedAuthFailure(error));
}
