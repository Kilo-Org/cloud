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

  it('times out immediately when startedAt is already past the overall timeout', async () => {
    const { setState, cleanup } = makePoll({
      startedAt: Date.now() - 5 * 60 * 1000 - 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    expect(setState).toHaveBeenCalled();
  });
});
