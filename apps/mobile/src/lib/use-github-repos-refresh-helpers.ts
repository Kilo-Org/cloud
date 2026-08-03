// Pure decision helpers for useGitHubReposRefresh, extracted so the test
// doesn't pull in react-native (Flow-syntax) via the hook module.

export type RefreshTrigger = 'sheet-close' | 'app-foreground';

/**
 * Maps a platform to the expected refetch trigger after the auth session
 * ends. Mirrors the connect-gate pattern.
 */
export function resolveRefreshTrigger(platform: string): RefreshTrigger {
  if (platform === 'ios') {
    return 'sheet-close';
  }
  return 'app-foreground';
}

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
