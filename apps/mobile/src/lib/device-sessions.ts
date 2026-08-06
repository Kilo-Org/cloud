import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** One active device session as returned by `user.listDeviceSessions`. */
export type DeviceSession = inferRouterOutputs<MobileRouter>['user']['listDeviceSessions'][number];

type DeviceSessionList = DeviceSession[];
export type RevokeDeviceSessionResult =
  inferRouterOutputs<MobileRouter>['user']['revokeDeviceSessionById'];

export const UNKNOWN_DEVICE_LABEL = 'Unknown device';
export const CURRENT_DEVICE_BADGE = 'This device';
export const NO_CURRENT_DEVICE_NOTE = 'Current device could not be identified';

/**
 * Derive a short, human-readable label from the raw `user_agent` HTTP header
 * stored on the session row.
 *
 * Browser requests always lead with the `Mozilla/5.0` compatibility token, so
 * those collapse to "Web browser". Everything else keeps its first product
 * token ("Kilo-Code/1.2.3" → "Kilo-Code", "axios/1.7.0" → "axios"), and a
 * missing or empty header falls back to "Unknown device".
 */
export function deviceSessionLabel(userAgent: string | null | undefined): string {
  const trimmed = userAgent?.trim() ?? '';
  if (!trimmed) {
    return UNKNOWN_DEVICE_LABEL;
  }
  if (trimmed.startsWith('Mozilla/')) {
    return 'Web browser';
  }
  const firstToken = trimmed.split(/\s+/)[0];
  if (!firstToken) {
    return UNKNOWN_DEVICE_LABEL;
  }
  // "Kilo-Code/1.2.3" → "Kilo-Code" (drop the version after the slash).
  const name = firstToken.split('/')[0]?.trim();
  return name ?? UNKNOWN_DEVICE_LABEL;
}

/**
 * Order sessions for display: the current device first, then the server's
 * `last_seen_at` descending order. `sort` on a copied array is stable (ES2019,
 * Hermes included), so the server order of the remaining rows is preserved.
 * The copy keeps the readonly input untouched — `toSorted` is not available
 * on Hermes.
 */
export function sortDeviceSessions(sessions: readonly DeviceSession[]): DeviceSession[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; the spread already prevents mutation of the source
  return [...sessions].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
}

type RevokeOutcomeKind = 'revoked' | 'already_revoked' | 'not_found' | 'error';

export type RevokeOutcome = {
  kind: RevokeOutcomeKind;
  toast: 'success' | 'info' | 'error';
  message: string;
  /** When true the list refetches to show the server's authoritative truth. */
  refetch: boolean;
};

type RevokeMutationError = { message: string; code?: string | null };

/**
 * Map a `revokeDeviceSessionById` mutation result (fulfilled or rejected) to
 * the exact UI action for that outcome. Only `NOT_FOUND` is terminal for the
 * row; every other rejection keeps the row and surfaces `error.message`.
 */
export function mapRevokeOutcome(
  result: RevokeDeviceSessionResult | undefined,
  error: RevokeMutationError | undefined
): RevokeOutcome {
  if (result?.outcome === 'revoked') {
    return { kind: 'revoked', toast: 'success', message: 'Session signed out.', refetch: true };
  }
  if (result?.outcome === 'already_revoked') {
    return {
      kind: 'already_revoked',
      toast: 'info',
      message: 'Session was already signed out',
      refetch: true,
    };
  }
  if (error?.code === 'NOT_FOUND') {
    return {
      kind: 'not_found',
      toast: 'error',
      message: 'This session is no longer active.',
      refetch: true,
    };
  }
  return {
    kind: 'error',
    toast: 'error',
    message: error?.message ?? 'Could not sign out this device.',
    refetch: false,
  };
}

export type DeviceSessionsQueryState = 'loading' | 'error' | 'empty' | 'happy' | 'no-current';

type ClassifyArgs = {
  isLoading: boolean;
  isError: boolean;
  data: DeviceSessionList | undefined;
};

/**
 * Classify the list query into the screen's five render states.
 *
 * A list WITH rows but no `isCurrent` row (a legacy token without the device
 * claim) is NOT empty: it renders the rows without a badge plus the footer
 * note — never the empty state.
 */
export function classifyDeviceSessionsState({
  isLoading,
  isError,
  data,
}: ClassifyArgs): DeviceSessionsQueryState {
  if (isLoading) {
    return 'loading';
  }
  if (isError) {
    return 'error';
  }
  if (!data || data.length === 0) {
    return 'empty';
  }
  return data.some(session => session.isCurrent) ? 'happy' : 'no-current';
}
