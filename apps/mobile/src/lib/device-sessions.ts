import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** One active device session as returned by `user.listDeviceSessions`. */
export type DeviceSession = inferRouterOutputs<MobileRouter>['user']['listDeviceSessions'][number];

const UNKNOWN_DEVICE_LABEL = 'Unknown device';

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
  // "Kilo-Code/1.2.3 (darwin; arm64)" → "Kilo-Code" (drop the version and the rest).
  return trimmed.split(/[\s/]/)[0] ?? UNKNOWN_DEVICE_LABEL;
}

/**
 * Order sessions for display: the current device first, then the rest in the
 * server's `last_seen_at` descending order. Both partitions keep the input
 * order, and the new array leaves the readonly input untouched.
 */
export function sortDeviceSessions(sessions: readonly DeviceSession[]): DeviceSession[] {
  return [
    ...sessions.filter(session => session.isCurrent),
    ...sessions.filter(session => !session.isCurrent),
  ];
}

type DeviceSessionsQueryState = 'loading' | 'error' | 'empty' | 'happy' | 'no-current';

type ClassifyArgs = {
  isLoading: boolean;
  isError: boolean;
  data: DeviceSession[] | undefined;
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
