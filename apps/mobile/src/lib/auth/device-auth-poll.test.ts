import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDeviceAuthPoll } from '@/lib/auth/device-auth-poll';
import { type DeviceAuthState } from '@/lib/auth/device-auth-state';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('expo-web-browser', () => ({
  dismissAuthSession: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

const fetchMock = vi.fn();

function pendingResponse() {
  return Response.json({ status: 'pending' }, { status: 202 });
}

function makePoll(overrides: { startedAt?: number } = {}) {
  const setState = vi.fn<(updater: (prev: DeviceAuthState) => DeviceAuthState) => void>();
  const cleanup = vi.fn<() => void>();
  const poll = startDeviceAuthPoll({
    code: 'UC',
    deviceCode: 'DC',
    signal: new AbortController().signal,
    setState,
    cleanup,
    ...overrides,
  });
  return { poll, setState, cleanup };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  fetchMock.mockReset();
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

  it('times out immediately when startedAt is already past the overall timeout', async () => {
    const { setState, cleanup } = makePoll({
      startedAt: Date.now() - 5 * 60 * 1000 - 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    expect(setState).toHaveBeenCalled();
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
    // 10s of the 5-minute budget remain when the poll starts.
    const { cleanup, setState } = makePoll({
      startedAt: Date.now() - (5 * 60 * 1000 - 10_000),
    });
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
});
