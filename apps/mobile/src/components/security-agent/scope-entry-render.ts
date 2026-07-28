export type ScopeEntryView =
  | 'loading'
  | 'error'
  | 'connect-github'
  | 'reauthorize'
  | 'disabled-settings'
  | 'dashboard';

export type SelectScopeEntryViewInput = {
  isLoading: boolean;
  isError: boolean;
  hasIntegration: boolean;
  hasPermissions: boolean;
  isEnabled: boolean;
};

/**
 * Pure selector deciding which view the Security Agent scope entry should
 * render. Mirrors the precedence in ScopeEntryScreen: loading first, then
 * error, then the missing-integration / missing-permission gates, then the
 * connected-but-disabled state, and finally the enabled dashboard.
 */
export function selectScopeEntryView({
  isLoading,
  isError,
  hasIntegration,
  hasPermissions,
  isEnabled,
}: SelectScopeEntryViewInput): ScopeEntryView {
  if (isLoading) {
    return 'loading';
  }
  if (isError) {
    return 'error';
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
