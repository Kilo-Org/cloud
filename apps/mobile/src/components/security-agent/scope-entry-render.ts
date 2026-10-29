export type ScopeEntryView =
  | 'loading'
  | 'error'
  | 'denied'
  | 'connect-github'
  | 'reauthorize'
  | 'disabled-settings'
  | 'dashboard';

export type SelectScopeEntryViewInput = {
  isLoading: boolean;
  isError: boolean;
  /**
   * The organization is gone from the reader's membership list, or an
   * organization query reported a denial. Outranks `isError` because it names
   * the cause, and the setup gates because no amount of setup can repair it.
   */
  isDenied: boolean;
  /**
   * Whether the GitHub status read produced a value. An enabled agent's
   * destination is already known from the config, and the dashboard reports
   * its own GitHub state, so a status that is still unread — pending, paused
   * or failed — must not hold the entry on a setup gate or an error screen.
   */
  isGithubStatusResolved: boolean;
  hasIntegration: boolean;
  hasPermissions: boolean;
  isEnabled: boolean;
};

/**
 * Pure selector deciding which view the Security Agent scope entry should
 * render. Mirrors the precedence in ScopeEntryScreen: loading first, then
 * access, then error, then the enabled destination while the GitHub status is
 * still unread, then the missing-integration / missing-permission gates, then
 * the connected-but-disabled state, and finally the enabled dashboard.
 */
export function selectScopeEntryView({
  isLoading,
  isError,
  isDenied,
  isGithubStatusResolved,
  hasIntegration,
  hasPermissions,
  isEnabled,
}: SelectScopeEntryViewInput): ScopeEntryView {
  if (isLoading) {
    return 'loading';
  }
  if (isDenied) {
    return 'denied';
  }
  if (isError) {
    return 'error';
  }
  if (isEnabled && !isGithubStatusResolved) {
    return 'dashboard';
  }
  if (!hasIntegration) {
    return 'connect-github';
  }
  if (!hasPermissions) {
    return 'reauthorize';
  }
  if (!isEnabled) {
    return 'disabled-settings';
  }
  return 'dashboard';
}
