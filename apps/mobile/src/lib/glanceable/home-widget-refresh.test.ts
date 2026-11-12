/**
 * The Home widget refresh credential is renewed whenever a glanceable snapshot
 * publishes. A credential the server refuses must stop that loop for the rest
 * of the signed-in session, and a transport failure must stay a breadcrumb the
 * network layer records instead of becoming a Sentry event of its own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';

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
    data: null as { snapshot: { status: string; scopeKey: string } } | null,
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

vi.mock('@/lib/glanceable-android/live-update', () => ({
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

vi.mock('@kilocode/app-shared/glanceable-agents-snapshot', () => ({
  buildGlanceableSnapshot: vi.fn(),
  buildOpaqueScopeKey: (scope: { userId: string; organizationId: string | null }) =>
    `${scope.userId}:${scope.organizationId ?? 'personal'}`,
}));

vi.mock('@kilocode/app-shared/home-widget', () => ({
  EMPTY_HOME_WIDGET_DETAILS: {},
  buildHomeWidgetPresentation: () => ({}),
  buildHomeWidgetPresentationTimeline: () => [],
  homeWidgetDataSchema: { safeParse: () => ({ success: false }) },
  homeWidgetRefreshAt: () => 0,
  homeWidgetResponseSchema: { safeParse: () => ({ success: false }) },
}));

const CONTEXT = { userId: 'user-1', organizationId: 'org-1' };
const SCOPE_KEY = 'user-1:org-1';

function trpcError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = 'TRPCClientError';
  return Object.assign(error, { data: { code } });
}

beforeEach(() => {
  _resetHomeWidgetRefreshForTests();
  mocks.widgetCredential.mockReset();
  mocks.captureException.mockReset();
  mocks.configure.mockReset().mockResolvedValue(undefined);
  mocks.clear.mockReset().mockResolvedValue(undefined);
  mocks.getOperationEpoch.mockReturnValue(0);
  mocks.data = { snapshot: { status: 'active', scopeKey: SCOPE_KEY } };
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
});
