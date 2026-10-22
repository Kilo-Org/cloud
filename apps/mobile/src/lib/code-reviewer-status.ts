import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';

// Pure classification logic for the code-reviewer domain's async query
// states. Kept dependency-free (no react-query/expo-router/react-native)
// so it can be unit-tested directly — the hooks that call these live in
// use-reviewer-permission.ts.

// Discriminated status for a connect-state query (GitHub/GitLab status,
// Bitbucket readiness) so screens can tell "still loading", "failed to
// load" (with retry) and "loaded, just not connected" apart instead of
// treating every non-connected state as the same "show the connect card"
// case — a query failure on an already-connected account must not render
// the connect card.
type ProviderErrorVariant = 'server' | 'permission' | 'not-found';

/**
 * Classify a TRPC error code into a provider error variant. A thrown
 * FORBIDDEN/UNAUTHORIZED/NOT_FOUND can't be fixed by retrying, so it's
 * `permanent` (rendered with the permission/not-found QueryError variant and
 * no retry); anything else is a transient server error.
 */
export function classifyProviderErrorCode(errorCode: string | undefined) {
  const permanent =
    errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED' || errorCode === 'NOT_FOUND';
  let variant: ProviderErrorVariant = 'server';
  if (errorCode === 'NOT_FOUND') {
    variant = 'not-found';
  } else if (permanent) {
    variant = 'permission';
  }
  return { permanent, variant };
}

type ProviderState =
  | { status: 'loading' }
  | {
      status: 'error';
      refetch: () => void;
      isRetrying: boolean;
      /** FORBIDDEN/UNAUTHORIZED/NOT_FOUND — a retry can't fix it, so hide retry. */
      permanent: boolean;
      variant: ProviderErrorVariant;
    }
  | { status: 'connected' }
  | { status: 'disconnected' };

export function classifyProviderState(input: {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  connected: boolean | undefined;
  hasData: boolean;
  refetch: () => void;
  /** TRPC error code (error.data?.code) when isError, for permanent-vs-transient classification. */
  errorCode?: string;
}): ProviderState {
  if (input.isLoading) {
    return { status: 'loading' };
  }
  // A background refetch failure with stale data present must not blank
  // out an already-connected screen — only an initial-load failure (no
  // cached data yet) is a hard error.
  if (input.isError && !input.hasData) {
    const { permanent, variant } = classifyProviderErrorCode(input.errorCode);
    return {
      status: 'error',
      refetch: input.refetch,
      isRetrying: input.isFetching,
      permanent,
      variant,
    };
  }
  // A paused query (offline/unknown connectivity) with an empty cache is
  // pending but not fetching, so `isLoading` (isPending && isFetching) is
  // false. "No data yet" must stay loading, not fall through to disconnected
  // (which renders the Connect card on a cold launch before NetInfo settles).
  if (!input.hasData) {
    return { status: 'loading' };
  }
  return input.connected ? { status: 'connected' } : { status: 'disconnected' };
}

// Discriminated status for "can this scope's role edit reviewer settings",
// so a still-loading or failed org-list fetch isn't silently treated as
// "read-only" (it used to fall through to `role === undefined` -> false).
export type PermissionState =
  | { status: 'loading' }
  | { status: 'error'; refetch: () => void; isRetrying: boolean }
  | { status: 'ready'; canEdit: boolean };

/**
 * Discriminated status for a reviewer config read's body, so a screen always
 * has exactly one surface to paint. The overview screens used to compose the
 * body from separate `isLoading` / `isError` / `paused` tests, and a config
 * query that reported none of them (`status: 'pending'`, `fetchStatus: 'idle'`,
 * no data — the state react-query reverts a cancelled first fetch to) matched
 * no branch at all: the header painted over an empty scroll area with no
 * spinner, no error, and nothing that would ever resolve it.
 *
 * - `ready`: cached config exists; a background refetch failure keeps the rows.
 * - `error`: a failed load with no cache, or a paused one whose pause is real
 *   (connectivity is known), so retry is the useful action.
 * - `loading`: any other in-flight, paused-while-connectivity-is-unsettled, or
 *   never-started read. `useIdleLoadRetry` restarts the last one.
 */
export type ConfigBodyState =
  | {
      status: 'loading';
      /** Pending with nothing in flight: nothing will ever resolve it on its own. */
      idle: boolean;
    }
  | { status: 'error'; variant: 'server' | 'offline'; isRetrying: boolean; refetch: () => void }
  | { status: 'ready' };

export function classifyConfigBody(input: {
  hasData: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  /** False while the app's probe-backed connectivity is still `unknown`. */
  connectivityKnown: boolean;
  refetch: () => void;
}): ConfigBodyState {
  if (input.hasData) {
    return { status: 'ready' };
  }
  if (input.isError) {
    return {
      status: 'error',
      variant: 'server',
      isRetrying: input.isFetching,
      refetch: input.refetch,
    };
  }
  if (input.fetchStatus === 'paused' && input.connectivityKnown) {
    return {
      status: 'error',
      variant: 'offline',
      isRetrying: input.isFetching,
      refetch: input.refetch,
    };
  }
  return { status: 'loading', idle: input.fetchStatus === 'idle' };
}

export function classifyPermission(input: {
  isPersonal: boolean;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  role: string | undefined;
  refetch: () => void;
}): PermissionState {
  if (input.isPersonal) {
    return { status: 'ready', canEdit: true };
  }
  if (input.isLoading) {
    return { status: 'loading' };
  }
  if (input.isError) {
    return { status: 'error', refetch: input.refetch, isRetrying: input.isFetching };
  }
  return { status: 'ready', canEdit: canManageOrganizationBilling(input.role) };
}
