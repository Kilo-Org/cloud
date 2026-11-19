/**
 * The Home widget refresh credential is renewed whenever a glanceable snapshot
 * publishes. A credential the server refuses must stop that loop for the rest
 * of the signed-in session, and a transport failure must stay a breadcrumb the
 * network layer records instead of becoming a Sentry event of its own.
 *
 * The shared policy runs for real: the payload the native bridge parses is the
 * one production builds, so a change to the wake retry or the timeline is
 * pinned here as well as in the policy's own suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { buildHomeWidgetData, type HomeWidgetData } from '@kilocode/app-shared/home-widget';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setProtectedDataAvailable } from '@/lib/protected-data';

import { _resetHomeWidgetRefreshForTests, syncHomeWidgetRefresh } from './home-widget-refresh';

const mocks = vi.hoisted(() => {
  const configure = vi.fn();
  const clear = vi.fn();
  const getOperationEpoch = vi.fn(() => 0);
  return {
    captureException: vi.fn(),
    widgetCredential: vi.fn(),
    configure,
    clear,
    getOperationEpoch,
    data: null as HomeWidgetData | null,
    orgConfirmationEpoch: 0,
    native: {
      configure,
      clear,
      getOperationEpoch,
      isCurrent: vi.fn().mockResolvedValue(true),
      getData: vi.fn(),
      getWidgetPushToken: vi.fn(),
      setFixtureMode: vi.fn(),
      widgetsChanged: vi.fn(),
    },
  };
});

vi.mock('@sentry/react-native', () => ({ captureException: mocks.captureException }));

vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.test' }));

vi.mock('@/glanceable-android/live-update', () => ({
  setWidgetSnapshot: vi.fn(),
  end: vi.fn(),
}));

vi.mock('@/lib/auth/token-owner', () => ({ isSignOutTeardownActive: () => false }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    activeSessions: { widgetCredential: { query: mocks.widgetCredential } },
  },
}));

vi.mock('./cleanup', () => ({
  getTerminalBlankEpoch: () => 0,
  getGlanceableOrgConfirmationEpoch: () => mocks.orgConfirmationEpoch,
  isGlanceableOrgLost: () => false,
}));

vi.mock('./fixture-hold', () => ({ isGlanceableFixtureHeld: () => false }));

vi.mock('./home-widget-copy', () => ({ getHomeWidgetCopy: () => ({ locale: 'en' }) }));

vi.mock('./scope', () => ({
  getActiveUserId: vi.fn().mockResolvedValue(null),
  getSelectedOrganizationId: vi.fn().mockResolvedValue(null),
}));

vi.mock('./home-widget-data', () => ({
  getLastHomeWidgetData: () => mocks.data,
  rememberHomeWidgetData: vi.fn(() => true),
  subscribeHomeWidgetData: () => () => undefined,
}));

const CONTEXT = { userId: 'user-1', organizationId: 'org-1' };
// The real builder and the module under test hash the same scope; the key is
// never the raw ids, so the fixture must hash it too.
const SCOPE_KEY = buildOpaqueScopeKey(CONTEXT);

function trpcError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = 'TRPCClientError';
  return Object.assign(error, { data: { code } });
}

type NativePayload = {
  scopeKey: string;
  data: HomeWidgetData;
  home: { awaitingUpdate: boolean; scheduledAt: string | null };
  refreshAt: number;
  presentationTimeline: { at: number }[];
};

/** The JSON text the native bridge parses, as `configure` received it. */
function configuredPayload(index: number): NativePayload {
  const call = mocks.configure.mock.calls[index];
  if (call === undefined) {
    throw new Error(`native configure was not called ${index + 1} times`);
  }
  return JSON.parse(String(call[0])) as NativePayload;
}

const MINUTE_MS = 60 * 1000;

beforeEach(() => {
  _resetHomeWidgetRefreshForTests();
  mocks.widgetCredential.mockReset();
  mocks.captureException.mockReset();
  mocks.configure.mockReset().mockResolvedValue(undefined);
  mocks.clear.mockReset().mockResolvedValue(undefined);
  mocks.getOperationEpoch.mockReturnValue(0);
  mocks.orgConfirmationEpoch = 0;
  // A real snapshot for the signed-in scope: the module under test runs the
  // shared policy over it, so every credential case still configures a payload
  // production could build.
  mocks.data = buildHomeWidgetData({
    userId: CONTEXT.userId,
    organizationId: CONTEXT.organizationId,
    now: Date.now(),
    sessions: [{ status: 'running' }],
  });
});

describe('syncHomeWidgetRefresh', () => {
  it('asks once for a refused credential and reports it once until the session changes', async () => {
    mocks.widgetCredential.mockRejectedValue(
      trpcError('UNAUTHORIZED', 'Widget credential is no longer authorized')
    );

    await syncHomeWidgetRefresh(CONTEXT);
    await syncHomeWidgetRefresh(CONTEXT);
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.widgetCredential).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0]?.[1]).toMatchObject({
      level: 'warning',
      tags: {
        'error.subsystem': 'home_widget',
        'error.operation': 'widget_credential_revoked',
      },
    });
    // The native widget drops the credential it can no longer use.
    expect(mocks.clear).toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();

    bumpAuthEpoch();
    mocks.widgetCredential.mockResolvedValue({
      token: 'renewed-token',
      expiresAt: Date.now() + 30 * 86_400_000,
    });

    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it('files nothing and latches nothing while the keychain is locked', async () => {
    // A locked device refuses every credential read, so the request went out
    // without a bearer and the server answered for a session, not for the
    // widget credential. That is the documented lock state: nothing is dropped,
    // latched or reported, and the next unlocked sync asks again.
    mocks.widgetCredential.mockRejectedValue(
      trpcError('UNAUTHORIZED', 'User not authenticated - no user to set on context')
    );
    setProtectedDataAvailable(false);
    try {
      await syncHomeWidgetRefresh(CONTEXT);
    } finally {
      setProtectedDataAvailable(true);
    }

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();

    mocks.widgetCredential.mockResolvedValue({
      token: 'unlocked-token',
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it('keeps the widget credential when the server refuses the session credential', async () => {
    // `authRequired` marks the context-level refusal: the request's session
    // bearer was missing or invalid, which the auth layer refreshes or ends.
    // The widget credential itself was never reached, so it is not revoked.
    const sessionRefusal = trpcError(
      'UNAUTHORIZED',
      'User not authenticated - no user to set on context'
    );
    Object.assign(sessionRefusal, {
      data: { code: 'UNAUTHORIZED', httpStatus: 401, authRequired: true },
    });
    mocks.widgetCredential.mockRejectedValue(sessionRefusal);

    await syncHomeWidgetRefresh(CONTEXT);
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();

    mocks.widgetCredential.mockResolvedValue({
      token: 'resumed-token',
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it('recovers once when a lost organization is confirmed again, without a sign-in', async () => {
    // A refusal can mean the organization membership is gone; that is
    // recoverable, so a confirmation releases the latch for the same session.
    mocks.widgetCredential.mockRejectedValue(
      trpcError('UNAUTHORIZED', 'Widget credential is no longer authorized')
    );
    await syncHomeWidgetRefresh(CONTEXT);
    await syncHomeWidgetRefresh(CONTEXT);
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);

    mocks.orgConfirmationEpoch += 1;
    mocks.widgetCredential.mockResolvedValue({
      token: 'restored-token',
      expiresAt: Date.now() + 30 * 86_400_000,
    });

    await syncHomeWidgetRefresh(CONTEXT);
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledTimes(1);

    // The renewed credential is cached, so later publishes configure without
    // asking again: the released latch does not turn into a request loop.
    await syncHomeWidgetRefresh(CONTEXT);
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledTimes(2);
  });

  it('reports a non-tRPC error carrying an UNAUTHORIZED code and keeps publishing', async () => {
    // The catch also covers the native configure call and the presentation
    // builders, so a bare top-level code is not a server verdict on the
    // credential: it must not silence refresh.
    mocks.widgetCredential.mockRejectedValue(
      Object.assign(new Error('widget store rejected the payload'), { code: 'UNAUTHORIZED' })
    );
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { 'error.subsystem': 'home_widget', 'error.operation': 'configure_native_refresh' },
    });

    mocks.widgetCredential.mockResolvedValue({
      token: 'fresh-token',
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.widgetCredential).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it('keeps a transport failure a breadcrumb and still reports a real defect', async () => {
    mocks.widgetCredential.mockRejectedValue(
      Object.assign(new Error('fetch failed: Unable to resolve host'), { name: 'TRPCClientError' })
    );
    await syncHomeWidgetRefresh(CONTEXT);
    expect(mocks.captureException).not.toHaveBeenCalled();

    // A deadline that expired while the app was suspended is a slow request,
    // not a defect: the network layer owns that outcome too.
    mocks.widgetCredential.mockRejectedValue(
      Object.assign(new Error('Request timed out after 15000ms'), { name: 'RequestDeadlineError' })
    );
    await syncHomeWidgetRefresh(CONTEXT);
    expect(mocks.captureException).not.toHaveBeenCalled();

    mocks.widgetCredential.mockRejectedValue(new TypeError('Cannot read properties of undefined'));
    await syncHomeWidgetRefresh(CONTEXT);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { 'error.subsystem': 'home_widget', 'error.operation': 'configure_native_refresh' },
    });
  });

  it('pins the one retry after a passed wake, then the ordinary active cadence', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_760_000_000_000;
      vi.setSystemTime(now);
      mocks.widgetCredential.mockResolvedValue({
        token: 'wake-token',
        expiresAt: now + 30 * 86_400_000,
      });

      // The snapshot was written at `now`, so its native aging boundary is the
      // active cadence after it; only the wake moves between the two cases.
      const stale = now + 30 * MINUTE_MS;

      // A session that should have woken five minutes ago: the bridge asks for
      // the one retry at wake + 15 minutes, not for the next full interval.
      const wake = now - 5 * MINUTE_MS;
      mocks.data = buildHomeWidgetData({
        userId: CONTEXT.userId,
        organizationId: CONTEXT.organizationId,
        now,
        sessions: [{ status: 'scheduled', scheduledAt: new Date(wake).toISOString() }],
      });
      await syncHomeWidgetRefresh(CONTEXT);

      const retry = wake + 15 * MINUTE_MS;
      const due = configuredPayload(0);
      expect(mocks.configure).toHaveBeenCalledTimes(1);
      expect(due.scopeKey).toBe(SCOPE_KEY);
      expect(due.data.snapshot.scheduledAt).toBe(new Date(wake).toISOString());
      expect(due.refreshAt).toBe(wake + 15 * MINUTE_MS);
      expect(due.home.awaitingUpdate).toBe(true);
      expect(due.home.scheduledAt).toBe(new Date(wake).toISOString());
      // The retry instant is one boundary, in ascending order and only once.
      expect(due.presentationTimeline.map(entry => entry.at)).toEqual([now, retry, stale]);

      // Forty minutes past the same wake: the retry deadline is gone too, so
      // the card stops promising an update and asks again on the active cadence.
      const lateWake = now - 40 * MINUTE_MS;
      mocks.data = buildHomeWidgetData({
        userId: CONTEXT.userId,
        organizationId: CONTEXT.organizationId,
        now,
        sessions: [{ status: 'scheduled', scheduledAt: new Date(lateWake).toISOString() }],
      });
      await syncHomeWidgetRefresh(CONTEXT);

      const late = configuredPayload(1);
      expect(mocks.configure).toHaveBeenCalledTimes(2);
      expect(late.data.snapshot.scheduledAt).toBe(new Date(lateWake).toISOString());
      expect(late.refreshAt).toBe(now + 30 * MINUTE_MS);
      expect(late.home.awaitingUpdate).toBe(false);
      expect(late.presentationTimeline.map(entry => entry.at)).toEqual([now, stale]);
      expect(late.presentationTimeline.at(-1)?.at).toBe(stale);
    } finally {
      vi.useRealTimers();
    }
  });
});
