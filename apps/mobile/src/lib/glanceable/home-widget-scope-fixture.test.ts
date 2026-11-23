/**
 * The widget scope fixture drives the real native `configure` with chosen
 * scopes: the synthetic one first, the same one again, then the signed-in
 * account's, so a simulator can watch the replaced scope's registration being
 * unregistered. Every step must end in exactly one log line, because the run is
 * read from device logs.
 *
 * The shared presentation builders run for real: the payload is the one
 * production builds, including the four presentation fields when a confirmed
 * record exists. No step fabricates a credential — the retirement POST has to
 * authenticate for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { buildHomeWidgetData, type HomeWidgetData } from '@kilocode/app-shared/home-widget';

import { handleHomeWidgetScopeFixturePath } from './home-widget-scope-fixture';

const mocks = vi.hoisted(() => {
  const configure = vi.fn();
  const setFixturePushToken = vi.fn();
  const setFixtureMode = vi.fn();
  const getOperationEpoch = vi.fn(() => 3);
  return {
    configure,
    setFixturePushToken,
    setFixtureMode,
    getOperationEpoch,
    widgetCredential: vi.fn(),
    getActiveUserId: vi.fn(),
    getSelectedOrganizationId: vi.fn(),
    currentAuthEpoch: vi.fn(() => 5),
    fetch: vi.fn(),
    holdGlanceableFixture: vi.fn(),
    releaseGlanceableFixtureHold: vi.fn(),
    data: null as HomeWidgetData | null,
    native: { configure, setFixturePushToken, setFixtureMode, getOperationEpoch },
  };
});

vi.mock('./home-widget-refresh', () => ({ HomeWidgetRefresh: mocks.native }));

vi.mock('./fixture-hold', () => ({
  holdGlanceableFixture: mocks.holdGlanceableFixture,
  releaseGlanceableFixtureHold: mocks.releaseGlanceableFixtureHold,
}));

vi.mock('./home-widget-copy', () => ({ getHomeWidgetCopy: () => ({ locale: 'en' }) }));

vi.mock('./home-widget-data', () => ({ getLastHomeWidgetData: () => mocks.data }));

vi.mock('./scope', () => ({
  getActiveUserId: mocks.getActiveUserId,
  getSelectedOrganizationId: mocks.getSelectedOrganizationId,
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.test' }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    activeSessions: { widgetCredential: { query: mocks.widgetCredential } },
  },
}));

vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: mocks.currentAuthEpoch }));

type FixtureStep = 'store' | 'register' | 'same' | 'changed' | 'off';

const CONTEXT = { userId: 'user-1', organizationId: 'org-1' };
const REAL_SCOPE_KEY = buildOpaqueScopeKey(CONTEXT);
const STAND_IN_TOKEN = /^[0-9a-f]{64}$/;
const PUSH_TOKEN_URL = 'https://api.example.test/api/mobile/widgets/push-token';

type NativePayload = {
  endpoint: string;
  token: string;
  organizationId: string | null;
  scopeKey: string;
  accountEpoch: number;
  operationEpoch: number;
  locale: string;
  data?: HomeWidgetData;
  home?: { status: string };
  refreshAt?: number;
  presentationTimeline?: { at: number }[];
};

/** The JSON text the native bridge parses, as `configure` received it. */
function configuredPayload(index: number): NativePayload {
  const call = mocks.configure.mock.calls[index];
  if (call === undefined) {
    throw new Error(`native configure was not called ${index + 1} times`);
  }
  return JSON.parse(String(call[0])) as NativePayload;
}

/** The request body and headers `fetch` received. */
function postedRequest(index: number): { url: string; body: string; headers: unknown } {
  const call = mocks.fetch.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch was not called ${index + 1} times`);
  }
  const init = call[1] as { body?: string; headers?: unknown } | undefined;
  return { url: String(call[0]), body: init?.body ?? '', headers: init?.headers };
}

let lines: string[] = [];

/** Handle one step link and wait for its single log line. */
async function step(name: FixtureStep): Promise<void> {
  expect(handleHomeWidgetScopeFixturePath(`kiloapp:///dev/home-widget-scope-fixture/${name}`)).toBe(
    true
  );
  await vi.waitFor(() => {
    expect(lines.some(line => line.startsWith(`home-widget-scope-fixture ${name} `))).toBe(true);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation(message => {
    lines.push(String(message));
  });
  mocks.configure.mockReset().mockResolvedValue(undefined);
  mocks.setFixturePushToken.mockReset().mockResolvedValue(undefined);
  mocks.setFixtureMode.mockReset().mockResolvedValue(undefined);
  mocks.getOperationEpoch.mockReset().mockReturnValue(3);
  mocks.widgetCredential
    .mockReset()
    .mockResolvedValue({ token: 'minted-credential', expiresAt: Date.now() + 30 * 86_400_000 });
  mocks.getActiveUserId.mockReset().mockResolvedValue(CONTEXT.userId);
  mocks.getSelectedOrganizationId.mockReset().mockResolvedValue(CONTEXT.organizationId);
  mocks.currentAuthEpoch.mockReset().mockReturnValue(5);
  mocks.holdGlanceableFixture.mockReset();
  mocks.releaseGlanceableFixtureHold.mockReset();
  mocks.fetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', mocks.fetch);
  // A confirmed record for the signed-in scope, so the payload carries the
  // presentation fields production derives from one.
  mocks.data = buildHomeWidgetData({
    ...CONTEXT,
    now: Date.now(),
    sessions: [{ status: 'running' }],
  });
});

describe('handleHomeWidgetScopeFixturePath', () => {
  it('returns false for a path that is not a fixture link and does nothing', () => {
    expect(handleHomeWidgetScopeFixturePath('kiloapp:///dev/glanceable-fixture/running')).toBe(
      false
    );
    expect(handleHomeWidgetScopeFixturePath('kiloapp:///dev/home-widget-scope-fixture')).toBe(
      false
    );
    expect(handleHomeWidgetScopeFixturePath('kiloapp:///dev/home-widget-scope-fixture/other')).toBe(
      false
    );

    expect(mocks.setFixtureMode).not.toHaveBeenCalled();
    expect(mocks.holdGlanceableFixture).not.toHaveBeenCalled();
    expect(mocks.releaseGlanceableFixtureHold).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.setFixturePushToken).not.toHaveBeenCalled();
    expect(mocks.widgetCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('handles every step', async () => {
    for (const name of ['store', 'register', 'same', 'changed', 'off'] as const) {
      expect(
        handleHomeWidgetScopeFixturePath(`kiloapp:///dev/home-widget-scope-fixture/${name}`)
      ).toBe(true);
    }
    await vi.waitFor(() => {
      expect(mocks.setFixtureMode).toHaveBeenCalledTimes(5);
    });
  });

  it('enables fixture mode, writes the stand-in token, then configures the synthetic scope', async () => {
    await step('store');

    // The JS hold lands once, before the first configure of the run.
    expect(mocks.holdGlanceableFixture).toHaveBeenCalledTimes(1);
    expect(mocks.holdGlanceableFixture.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.configure.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.releaseGlanceableFixtureHold).not.toHaveBeenCalled();
    expect(mocks.setFixtureMode).toHaveBeenCalledWith(true);
    expect(mocks.setFixturePushToken).toHaveBeenCalledTimes(1);
    expect(mocks.setFixturePushToken.mock.calls[0]?.[0]).toMatch(STAND_IN_TOKEN);
    // Fixture mode first, then the token, then the configure that registers it.
    const modeOrder = mocks.setFixtureMode.mock.invocationCallOrder[0] ?? 0;
    const tokenOrder = mocks.setFixturePushToken.mock.invocationCallOrder[0] ?? 0;
    const configureOrder = mocks.configure.mock.invocationCallOrder[0] ?? 0;
    expect(modeOrder).toBeLessThan(tokenOrder);
    expect(tokenOrder).toBeLessThan(configureOrder);

    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(configuredPayload(0)).toMatchObject({
      endpoint: 'https://api.example.test/api/mobile/widgets',
      token: 'minted-credential',
      organizationId: CONTEXT.organizationId,
      scopeKey: 'fixture:outgoing',
      accountEpoch: 0,
      operationEpoch: 4,
      locale: 'en',
    });
    expect(configuredPayload(0).data).toEqual(mocks.data);
    expect(configuredPayload(0).home?.status).toBeTypeOf('string');
    expect(configuredPayload(0).refreshAt).toBeTypeOf('number');
    expect(configuredPayload(0).presentationTimeline?.length).toBeGreaterThan(0);
    // A real credential, minted for the selected scope.
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(1);
    expect(mocks.widgetCredential.mock.calls[0]?.[0]).toEqual({
      organizationId: CONTEXT.organizationId,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(lines).toEqual(['home-widget-scope-fixture store stored the synthetic scope']);
  });

  it('posts the stand-in token for the synthetic scope with a real credential', async () => {
    await step('register');

    expect(mocks.holdGlanceableFixture).toHaveBeenCalledTimes(1);
    expect(mocks.holdGlanceableFixture.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.fetch.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.releaseGlanceableFixtureHold).not.toHaveBeenCalled();
    expect(mocks.setFixtureMode).toHaveBeenCalledWith(true);
    expect(mocks.setFixtureMode.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.widgetCredential.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(1);
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const posted = postedRequest(0);
    expect(posted.url).toBe(PUSH_TOKEN_URL);
    expect(posted.headers).toEqual({
      Authorization: 'Bearer minted-credential',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(posted.body) as { token: string; enabled: boolean };
    expect(body.token).toMatch(STAND_IN_TOKEN);
    expect(body.enabled).toBe(true);
    expect(lines).toEqual([
      'home-widget-scope-fixture register posted the stand-in token (HTTP 200)',
    ]);
  });

  it('configures the same synthetic scope again without writing the token or posting', async () => {
    await step('store');
    mocks.configure.mockClear();
    mocks.setFixturePushToken.mockClear();
    mocks.widgetCredential.mockClear();
    mocks.holdGlanceableFixture.mockClear();
    lines = [];

    await step('same');

    expect(mocks.holdGlanceableFixture).toHaveBeenCalledTimes(1);
    expect(mocks.releaseGlanceableFixtureHold).not.toHaveBeenCalled();
    expect(mocks.setFixtureMode).toHaveBeenLastCalledWith(true);
    expect(mocks.setFixturePushToken).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(configuredPayload(0)).toMatchObject({
      scopeKey: 'fixture:outgoing',
      accountEpoch: 0,
    });
    expect(lines).toEqual(['home-widget-scope-fixture same kept the synthetic scope']);
  });

  it('configures the signed-in scope with a fresh credential and the current auth epoch', async () => {
    await step('store');
    mocks.configure.mockClear();
    mocks.widgetCredential.mockClear();
    mocks.setFixturePushToken.mockClear();
    mocks.holdGlanceableFixture.mockClear();
    lines = [];

    await step('changed');

    expect(mocks.holdGlanceableFixture).toHaveBeenCalledTimes(1);
    expect(mocks.holdGlanceableFixture.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.configure.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.releaseGlanceableFixtureHold).not.toHaveBeenCalled();
    expect(mocks.setFixtureMode).toHaveBeenLastCalledWith(true);
    expect(mocks.widgetCredential).toHaveBeenCalledTimes(1);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(configuredPayload(0)).toMatchObject({
      scopeKey: REAL_SCOPE_KEY,
      accountEpoch: 5,
      token: 'minted-credential',
      organizationId: CONTEXT.organizationId,
    });
    // The replacement leaves the stand-in token in place: the native side, not
    // this fixture, unregisters it.
    expect(mocks.setFixturePushToken).not.toHaveBeenCalled();
    expect(lines).toEqual(['home-widget-scope-fixture changed replaced the synthetic scope']);
  });

  it('disables fixture mode, clears the token, then releases the hold', async () => {
    await step('off');

    expect(mocks.setFixtureMode).toHaveBeenCalledWith(false);
    expect(mocks.setFixturePushToken).toHaveBeenCalledWith(null);
    expect(mocks.setFixtureMode.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.setFixturePushToken.mock.invocationCallOrder[0] ?? 0
    );
    // `off` takes no hold of its own and hands the surfaces back last.
    expect(mocks.holdGlanceableFixture).not.toHaveBeenCalled();
    expect(mocks.releaseGlanceableFixtureHold).toHaveBeenCalledTimes(1);
    expect(mocks.setFixturePushToken.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.releaseGlanceableFixtureHold.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'home-widget-scope-fixture off fixture mode off, token cleared, hold released',
    ]);
  });

  it('configures nothing when no user is signed in', async () => {
    mocks.getActiveUserId.mockResolvedValue(null);

    await step('changed');

    expect(mocks.widgetCredential).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(lines).toEqual(['home-widget-scope-fixture changed skipped (no signed-in user)']);
  });

  it('logs a failure instead of rejecting when the native module refuses', async () => {
    mocks.configure.mockRejectedValue(new Error('Widget storage unavailable'));

    await step('same');

    expect(lines).toEqual(['home-widget-scope-fixture same failed: Widget storage unavailable']);
  });
});
