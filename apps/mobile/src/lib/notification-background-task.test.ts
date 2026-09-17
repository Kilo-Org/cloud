import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_NOTIFICATION_TASK,
  registerNotificationBackgroundTask,
} from './notification-background-task';

const mocks = vi.hoisted(() => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(),
  captureException: vi.fn(),
  runBackgroundNotificationTask: vi.fn(),
}));

vi.mock('expo-task-manager', () => ({
  defineTask: mocks.defineTask,
}));

vi.mock('expo-notifications', () => ({
  registerTaskAsync: mocks.registerTaskAsync,
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

// The task executor lazy-loads the notification module so the entry (which
// requires this file on every start, including widget headless starts) never
// builds that graph; the suite stubs it.
vi.mock('./notifications', () => ({
  runBackgroundNotificationTask: mocks.runBackgroundNotificationTask,
}));

beforeEach(() => {
  mocks.defineTask.mockReset();
  mocks.registerTaskAsync.mockReset().mockResolvedValue(undefined);
  mocks.captureException.mockReset();
  mocks.runBackgroundNotificationTask.mockReset().mockResolvedValue(1);
});

describe('registerNotificationBackgroundTask', () => {
  it('defines the one background-notification task name and registers it natively', async () => {
    await registerNotificationBackgroundTask();

    expect(mocks.defineTask).toHaveBeenCalledTimes(1);
    expect(mocks.defineTask).toHaveBeenCalledWith(
      'active-agents-glanceable-background-task',
      expect.any(Function)
    );
    expect(mocks.registerTaskAsync).toHaveBeenCalledTimes(1);
    expect(mocks.registerTaskAsync).toHaveBeenCalledWith(BACKGROUND_NOTIFICATION_TASK);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('executes a task through the lazy notification-module load', async () => {
    await registerNotificationBackgroundTask();
    // Laziness is the entry contract: no notification-graph module runs until a
    // task fires.
    expect(mocks.runBackgroundNotificationTask).not.toHaveBeenCalled();

    const executor = mocks.defineTask.mock.calls[0]?.[1] as (body: unknown) => Promise<number>;
    const body = {
      data: { actionIdentifier: 'kilo:approve', notification: { request: {} } },
      error: null,
      executionInfo: { eventId: 'e1', taskName: BACKGROUND_NOTIFICATION_TASK },
    };

    await expect(executor(body)).resolves.toBe(1);
    expect(mocks.runBackgroundNotificationTask).toHaveBeenCalledWith(body);
  });

  it('reports a failed native registration to Sentry without rejecting', async () => {
    mocks.registerTaskAsync.mockRejectedValue(new Error('native registry unavailable'));

    await expect(registerNotificationBackgroundTask()).resolves.toBeUndefined();
    // The reporter loads Sentry asynchronously; settle it before asserting.
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          'error.subsystem': 'notifications',
          'error.operation': 'register_background_task',
        }),
      })
    );
  });
});
