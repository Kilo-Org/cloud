import { isUnauthorizedTrpcError } from '@/lib/auth/trpc-unauthorized';
import { type BannerState } from '@/lib/offline-banner-state';
import { readTrpcErrorField } from '@/lib/trpc-error';

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

/**
 * Whether the install state was refused for this caller's organization role.
 *
 * `githubApps.mintInstallState` authorizes through `resolveAuthorizedOwner(...,
 * ORGANIZATION_MANAGE_ROLES)` (`apps/web/src/lib/integrations/resolve-owner.ts`)
 * before it writes anything, and `ensureOrganizationAccess` answers
 * `UNAUTHORIZED` for a role below that. That answer is the server's own role
 * decision, so the entry reads it instead of inferring the role on the device: a
 * local membership read cannot see the server's Kilo-admin elevation or a
 * parent-organization role, and withholding the press on it would deny callers
 * the server admits. Any other failure is a retryable error, not a role answer.
 *
 * A context-level auth failure — an invalid or missing session — is also
 * `UNAUTHORIZED`, but it is flagged `data.authRequired`, the same way
 * `isPermissionDeniedError` tells it apart. It is not a role answer: the app
 * signs the reader out on it, and a personal scope has no organization whose
 * owner could be asked to connect.
 */
export function isInstallStateRefusal(error: unknown): boolean {
  return readTrpcErrorField(error, 'code') === 'UNAUTHORIZED' && !isUnauthorizedTrpcError(error);
}

/** The cause-named description the failure screen shows, or null for the variant's own copy. */
type ScopeEntryLoadFailureDescriptionKey =
  | 'organization.boundary.loadErrorMessage'
  | 'securityAgent.scopeEntry.retryFailed';

export type ScopeEntryLoadFailure = {
  /**
   * `offline` when the connection is the cause: the WifiOff icon and the same
   * state the rest of the app paints for an unreachable read.
   */
  variant: 'offline' | 'server';
  /** Description override; null keeps the variant's own description. */
  descriptionKey: ScopeEntryLoadFailureDescriptionKey | null;
};

export type SelectScopeEntryLoadFailureInput = {
  /** Errors of the reads whose failure produced the error view. */
  errors: readonly unknown[];
  /** A read paused by the online manager; only an offline online-manager pauses. */
  isPaused: boolean;
  /** Committed connectivity — the state the offline banner paints. */
  connectivity: BannerState;
  /** The reader's last Retry ran and failed again. */
  lastAttemptFailed: boolean;
};

/**
 * Pure selector naming the cause of the scope entry's load failure.
 *
 * The entry paints one error screen for three fatal reads (permission status,
 * config, capability) and used to paint it with no cause at all: the default
 * server wording told the reader the app's own system had a problem even when
 * the request never reached it, and only a failed retry named the connection.
 * The cause is the one the rest of the app already classifies:
 *
 * - a paused read, or confirmed-offline connectivity, is the connection;
 * - a failed read that carries a tRPC code is a server answer, so the system
 *   wording stays even after a failed retry (naming the connection there would
 *   blame the wrong party);
 * - any other failed read never reached the server at all — a transport
 *   rejection carries no code — which is the connection too.
 */
export function selectScopeEntryLoadFailure({
  errors,
  isPaused,
  connectivity,
  lastAttemptFailed,
}: SelectScopeEntryLoadFailureInput): ScopeEntryLoadFailure {
  const serverAnswered = errors.some(error => readTrpcErrorField(error, 'code') !== undefined);
  const isConnection =
    isPaused || connectivity === 'offline' || (errors.length > 0 && !serverAnswered);
  if (!isConnection) {
    return { variant: 'server', descriptionKey: null };
  }
  return {
    variant: 'offline',
    descriptionKey: lastAttemptFailed
      ? 'securityAgent.scopeEntry.retryFailed'
      : 'organization.boundary.loadErrorMessage',
  };
}
