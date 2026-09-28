import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_ACTIVITY_KEY } from '@/lib/storage-keys';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('live-activity preference store', () => {
  beforeEach(() => {
    vi.resetModules();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('defaults to on when SecureStore returns null', async () => {
    getItemAsync.mockResolvedValue(null);
    const { getLiveActivityEnabled } = await import('./use-live-activity-preference');

    await flushMicrotasks();

    expect(getLiveActivityEnabled()).toBe(true);
  });

  it("reads the stored string 'false' as off", async () => {
    getItemAsync.mockResolvedValue('false');
    const { getLiveActivityEnabled } = await import('./use-live-activity-preference');

    await flushMicrotasks();

    expect(getLiveActivityEnabled()).toBe(false);
  });

  it('round-trips a set through the same store a get sees', async () => {
    getItemAsync.mockResolvedValue(null);
    const { getLiveActivityEnabled, setLiveActivityEnabled } =
      await import('./use-live-activity-preference');

    setLiveActivityEnabled(false);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith(LIVE_ACTIVITY_KEY, 'false');
    expect(getLiveActivityEnabled()).toBe(false);

    setLiveActivityEnabled(true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith(LIVE_ACTIVITY_KEY, 'true');
    expect(getLiveActivityEnabled()).toBe(true);
  });

  it('mirrors every write into the sink switch', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setLiveActivityEnabled } = await import('./use-live-activity-preference');
    const sink = await import('@/lib/glanceable/live-activity-switch');

    setLiveActivityEnabled(false);
    expect(sink.getLiveActivityEnabled()).toBe(false);

    setLiveActivityEnabled(true);
    expect(sink.getLiveActivityEnabled()).toBe(true);
  });

  it('mirrors the stored value the disk read lands on', async () => {
    getItemAsync.mockResolvedValue('false');
    await import('./use-live-activity-preference');
    const sink = await import('@/lib/glanceable/live-activity-switch');

    await flushMicrotasks();

    expect(sink.getLiveActivityEnabled()).toBe(false);
  });

  it('clears back to the default and deletes the key', async () => {
    getItemAsync.mockResolvedValue('false');
    const { clearLiveActivityPreference, getLiveActivityEnabled } =
      await import('./use-live-activity-preference');

    await flushMicrotasks();
    expect(getLiveActivityEnabled()).toBe(false);

    clearLiveActivityPreference();
    await flushMicrotasks();

    expect(getLiveActivityEnabled()).toBe(true);
    expect(deleteItemAsync).toHaveBeenCalledWith(LIVE_ACTIVITY_KEY);
  });
});
