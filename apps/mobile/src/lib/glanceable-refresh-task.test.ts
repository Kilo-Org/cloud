import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GLANCEABLE_REFRESH_TASK, registerGlanceableRefreshTask } from './glanceable-refresh-task';

const mocks = vi.hoisted(() => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(),
  captureException: vi.fn(),
  runGlanceableBackgroundRefresh: vi.fn(),
}));

vi.mock('expo-task-manager', () => ({
  defineTask: mocks.defineTask,
}));

vi.mock('expo-background-task', () => ({
  registerTaskAsync: mocks.registerTaskAsync,
}));

// The shared failure reporter lives beside the notification task, which
// imports `expo-notifications`.
vi.mock('expo-notifications', () => ({ registerTaskAsync: vi.fn() }));
vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

// The executor lazy-loads the notification module so the entry never builds
// that graph; the suite stubs it.
vi.mock('./notifications', () => ({
  runGlanceableBackgroundRefresh: mocks.runGlanceableBackgroundRefresh,
}));

beforeEach(() => {
  mocks.defineTask.mockReset();
  mocks.registerTaskAsync.mockReset().mockResolvedValue(undefined);
  mocks.captureException.mockReset();
  mocks.runGlanceableBackgroundRefresh.mockReset().mockResolvedValue(1);
});

describe('registerGlanceableRefreshTask', () => {
  it('registers the refresh at the WorkManager floor and runs it through the lazy load', async () => {
    await registerGlanceableRefreshTask();

    expect(mocks.registerTaskAsync).toHaveBeenCalledExactlyOnceWith(GLANCEABLE_REFRESH_TASK, {
      minimumInterval: 15,
    });
    expect(mocks.runGlanceableBackgroundRefresh).not.toHaveBeenCalled();

    const [name, executor] = mocks.defineTask.mock.calls[0] as [string, () => Promise<number>];
    expect(name).toBe(GLANCEABLE_REFRESH_TASK);
    await expect(executor()).resolves.toBe(1);
    expect(mocks.runGlanceableBackgroundRefresh).toHaveBeenCalledOnce();
  });

  it('reports a failed native registration to Sentry without rejecting', async () => {
    mocks.registerTaskAsync.mockRejectedValue(new Error('BGTaskScheduler unavailable'));

    await expect(registerGlanceableRefreshTask()).resolves.toBeUndefined();
    // The reporter loads Sentry asynchronously; settle it before asserting.
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ 'error.operation': 'register_glanceable_refresh_task' }),
      })
    );
  });
});
