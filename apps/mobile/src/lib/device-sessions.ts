import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';

/** One active device session as returned by `user.listDeviceSessions`. */
export type DeviceSession = inferRouterOutputs<MobileRouter>['user']['listDeviceSessions'][number];

/**
 * Title one session row from the client the server classified for it.
 *
 * The server reads the recorded `user_agent` header once and returns the kind
 * with the row, so the app never parses a header itself. An app session also
 * carries the platform it runs on, the CLI and a browser keep one name each,
 * and any other client is titled by the product token the server extracted
 * (`axios/1.7.0` → "axios") — or "Unknown device" when the row recorded no
 * header at all.
 *
 * `device_auth_request_id` is not a CLI marker: the app's own browser sign-in
 * sets it too. The client kind therefore comes from the recorded user agent.
 */
export function deviceSessionLabel(
  session: Pick<DeviceSession, 'kind' | 'platform' | 'clientName'>
): string {
  if (session.kind === 'app') {
    if (session.platform === 'android') {
      return i18n.t('deviceSessions.kiloAppAndroid');
    }
    if (session.platform === 'ios') {
      return i18n.t('deviceSessions.kiloAppIos');
    }
    // An app row always names its platform today; the unqualified app name
    // keeps the label defined if the server ever reports another one.
    return i18n.t('deviceSessions.kiloApp');
  }
  if (session.kind === 'cli') {
    return i18n.t('deviceSessions.kiloCli');
  }
  if (session.kind === 'browser') {
    return i18n.t('deviceSessions.webBrowser');
  }
  return session.clientName ?? i18n.t('deviceSessions.unknownDevice');
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
