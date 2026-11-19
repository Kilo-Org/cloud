import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissAuthSession, dismissBrowser } from 'expo-web-browser';

import { deviceAuthExpiresAt, startDeviceAuthPoll } from '@/lib/auth/device-auth-poll';
import { type DeviceAuthState } from '@/lib/auth/device-auth-state';

const platformMock = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformMock.os;
    },
  },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('expo-web-browser', () => ({
  dismissAuthSession: vi.fn(),
  dismissBrowser: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

const fetchMock = vi.fn();

function approvedResponse() {
  return Response.json({ status: 'approved', token: 'access', expiresIn: 3600 });
}

function pendingResponse() {
  return Response.json({ status: 'pending' }, { status: 202 });
}

function makePoll(
  overrides: { expiresAt?: number; browserKind?: 'auth-session' | 'plain-browser' } = {}
) {
  const setState = vi.fn<(updater: (prev: DeviceAuthState) => DeviceAuthState) => void>();
  const cleanup = vi.fn<() => void>();
  const poll = startDeviceAuthPoll({
    code: 'UC',
    deviceCode: 'DC',
    signal: new AbortController().signal,
    setState,
    cleanup,
    browserKind: 'auth-session',
    expiresAt: deviceAuthExpiresAt(Date.now(), 600),
    ...overrides,
  });
  return { poll, setState, cleanup };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  fetchMock.mockReset();
  vi.mocked(dismissAuthSession).mockClear();
  vi.mocked(dismissBrowser).mockClear();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startDeviceAuthPoll', () => {
  it('returns { cleanup, pollNow }', () => {
    const { poll } = makePoll();
    expect(typeof poll.cleanup).toBe('function');
    expect(typeof poll.pollNow).toBe('function');
  });

  it('pollNow is a no-op within 1s of the previous tick', async () => {
    fetchMock.mockResolvedValue(pendingResponse());
    const { poll } = makePoll();
    // First scheduled tick fires at 3s.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 0ms since the last tick — skipped.
    poll.pollNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pollNow triggers one immediate poll after 1s since the previous tick', async () => {
    fetchMock.mockResolvedValue(pendingResponse());
    const { poll } = makePoll();
    // First scheduled tick fires at 3s.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // >1s since the last tick, but before the next scheduled tick.
    await vi.advanceTimersByTimeAsync(1500);
    poll.pollNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll early when foregrounded during a Retry-After cooldown', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS' },
        { status: 429, headers: { 'retry-after': '90' } }
      )
    );
    const { poll } = makePoll();
    // First scheduled tick at 3s is throttled with a 90s Retry-After.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Foreground well after the 1s guard but before the cooldown expires: the
    // server asked us to wait, so no poll may be sent early.
    await vi.advanceTimersByTimeAsync(10_000);
    poll.pollNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The cooldown still ends on the server's schedule, not later.
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends one final poll when the budget has already passed, then times out', async () => {
    fetchMock.mockResolvedValue(pendingResponse());
    const { setState, cleanup } = makePoll({ expiresAt: Date.now() - 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalled();
    const next = setState.mock.calls.at(-1)?.[0]?.({
      status: 'pending',
      code: 'UC',
      token: undefined,
      refreshToken: undefined,
      expiresIn: undefined,
      error: undefined,
      verificationUrl: undefined,
    });
    expect(next).toMatchObject({
      status: 'error',
      error: { kind: 'key', key: 'authErrors.signInTimedOut' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signs in on a foreground return after 5 minutes while the server code still lives', async () => {
    // The browser approved the code while the app was in the background, where
    // JS timers do not run. The server code lives 10 minutes.
    fetchMock.mockResolvedValueOnce(pendingResponse());
    const { poll, setState } = makePoll({ expiresAt: deviceAuthExpiresAt(Date.now(), 600) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(approvedResponse());
    poll.pollNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const next = setState.mock.calls.at(-1)?.[0]?.({
      status: 'pending',
      code: 'UC',
      token: undefined,
      refreshToken: undefined,
      expiresIn: undefined,
      error: undefined,
      verificationUrl: undefined,
    });
    expect(next).toMatchObject({ status: 'approved', token: 'access' });
  });

  it('derives the budget from the server code lifetime', async () => {
    fetchMock.mockResolvedValue(pendingResponse());
    const { cleanup } = makePoll({ expiresAt: deviceAuthExpiresAt(Date.now(), 600) });
    // Still polling past the old fixed 5-minute budget.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(cleanup).toHaveBeenCalled();
  });

  it('honours a Retry-After longer than its own backoff on a throttled poll', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS' },
        { status: 429, headers: { 'retry-after': '90' } }
      )
    );
    makePoll();
    // First scheduled tick at 3s is throttled.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Our own backoff would fire again at 6s; the server asked for 90s.
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(83_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps a Retry-After longer than the remaining budget by the time left', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS' },
        { status: 429, headers: { 'retry-after': '90' } }
      )
    );
    // 10s of the budget remain when the poll starts.
    const { cleanup, setState } = makePoll({ expiresAt: Date.now() + 10_000 });
    // The first scheduled tick at 3s is throttled with a 90s Retry-After.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Only 7s of the budget are left, so the wait is capped by that instead of
    // the whole budget: the timeout surfaces at the budget, not 90s later.
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalled();
    expect(setState).toHaveBeenCalled();
  });

  it('dismisses the plain browser it opened when approval lands', async () => {
    // A non-product auth host opens SFSafariViewController, which
    // `dismissAuthSession` cannot close: without the matching dismissal the page
    // stays over the approved app.
    fetchMock.mockResolvedValue(approvedResponse());
    const { setState } = makePoll({ browserKind: 'plain-browser' });

    await vi.advanceTimersByTimeAsync(3000);

    expect(vi.mocked(dismissBrowser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dismissAuthSession)).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalled();
  });

  it('dismisses the native auth session it opened when approval lands', async () => {
    fetchMock.mockResolvedValue(approvedResponse());
    makePoll({ browserKind: 'auth-session' });

    await vi.advanceTimersByTimeAsync(3000);

    expect(vi.mocked(dismissAuthSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dismissBrowser)).not.toHaveBeenCalled();
  });

  it('keeps the pending link result an approval carries for the sign-in to announce', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        status: 'approved',
        token: 'access',
        pendingLink: { status: 'failed', reason: 'WRONG_ACCOUNT' },
      })
    );
    const { setState } = makePoll();

    await vi.advanceTimersByTimeAsync(3000);

    const updater = setState.mock.calls[0]?.[0];
    const next = updater?.({
      status: 'pending',
      code: 'UC',
      token: undefined,
      refreshToken: undefined,
      expiresIn: undefined,
      error: undefined,
      verificationUrl: 'https://app.kilo.ai/device-auth?code=UC',
    });
    expect(next).toMatchObject({
      status: 'approved',
      token: 'access',
      pendingLink: { status: 'failed', reason: 'WRONG_ACCOUNT' },
    });
  });

  it('leaves the Android custom tab to the user when approval lands', async () => {
    platformMock.os = 'android';
    try {
      fetchMock.mockResolvedValue(approvedResponse());
      makePoll({ browserKind: 'plain-browser' });

      await vi.advanceTimersByTimeAsync(3000);

      expect(vi.mocked(dismissBrowser)).not.toHaveBeenCalled();
      expect(vi.mocked(dismissAuthSession)).not.toHaveBeenCalled();
    } finally {
      platformMock.os = 'ios';
    }
  });
});
