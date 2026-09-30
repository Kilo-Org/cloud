import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';

/** One active device session as returned by `user.listDeviceSessions`. */
export type DeviceSession = inferRouterOutputs<MobileRouter>['user']['listDeviceSessions'][number];

/**
 * Product tokens of the platform HTTP client React Native puts on the wire
 * when the app does not set its own `User-Agent`. They name the transport, not
 * the device, so a header that leads with one identifies nothing to show.
 */
const TRANSPORT_ONLY_PRODUCT_TOKEN = /^okhttp$/i;

/**
 * Derive a short, human-readable label from the raw `user_agent` HTTP header
 * stored on the session row.
 *
 * Browser requests always lead with the `Mozilla/5.0` compatibility token, so
 * those collapse to "Web browser". A header that leads with a bare transport
 * token ("okhttp/4.12.0") identifies no device, so it falls back to
 * "Unknown device" like a missing header. Everything else keeps its first
 * product token ("Kilo-Code/1.2.3" → "Kilo-Code", "axios/1.7.0" → "axios"),
 * and a missing or empty header falls back to "Unknown device".
 */
export function deviceSessionLabel(userAgent: string | null | undefined): string {
  const trimmed = userAgent?.trim() ?? '';
  if (!trimmed) {
    return i18n.t('kiloclaw.devicePairing.unknownDevice');
  }
  if (trimmed.startsWith('Mozilla/')) {
    return i18n.t('deviceSessions.webBrowser');
  }
  // "Kilo-Code/1.2.3 (darwin; arm64)" → "Kilo-Code" (drop the version and the rest).
  const product = trimmed.split(/[\s/]/)[0] ?? '';
  if (!product || TRANSPORT_ONLY_PRODUCT_TOKEN.test(product)) {
    return i18n.t('kiloclaw.devicePairing.unknownDevice');
  }
  return product;
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
  /**
   * `isPending` (no data yet), NOT React Query v5's `isLoading`
   * (`isPending && isFetching`): the first render before the observer starts
   * the fetch and a paused (offline) query are pending but not fetching, so
   * `isLoading` would classify a cold open as `empty` and flash the empty
   * state before the request settles.
   */
  isPending: boolean;
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
  isPending,
  isError,
  data,
}: ClassifyArgs): DeviceSessionsQueryState {
  if (isPending) {
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
