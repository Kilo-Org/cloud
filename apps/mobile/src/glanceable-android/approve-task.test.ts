import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVE_AGENT_TASK_KEY,
  type ApproveRunner,
  registerApproveTask,
  runApproveTask,
} from './approve-task';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const tasks = new Map<string, () => Promise<void>>();
  return {
    order,
    tasks,
    applyWidgetLanguage: vi.fn(async () => {
      await Promise.resolve();
      order.push('language');
    }),
    approveFrontAgent: vi.fn(async () => {
      await Promise.resolve();
      order.push('approve');
    }),
    registerHeadlessTask: vi.fn((key: string, provider: () => () => Promise<void>) => {
      tasks.set(key, provider());
    }),
  };
});

// The task must run with no Activity and no rendered tree: AppRegistry is the
// only React Native surface reachable here, so a renderer dependency would fail
// this suite.
vi.mock('react-native', () => ({
  AppRegistry: { registerHeadlessTask: mocks.registerHeadlessTask },
}));
// The widget slice's language step is imported on task fire; stub it so the
// headless flow is observed without loading the widget sink.
vi.mock('./register', () => ({ applyWidgetLanguage: mocks.applyWidgetLanguage }));
vi.mock('@/lib/glanceable/approve-front-agent', () => ({
  approveFrontAgent: mocks.approveFrontAgent,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.tasks.clear();
});

/** The injected approval: resolved or rejected, never reaching the outcome. */
const approveThatResolves = (): ApproveRunner => vi.fn().mockResolvedValue(undefined);

describe('runApproveTask', () => {
  it('applies the stored language before it approves', async () => {
    const approve = vi.fn(async () => {
      await Promise.resolve();
      mocks.order.push('approve');
    });

    await runApproveTask(approve);

    expect(mocks.order).toEqual(['language', 'approve']);
  });

  it('finishes the task when the approval fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('permission response rejected'));

    await expect(runApproveTask(approve)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('still approves when the language cannot be applied', async () => {
    mocks.applyWidgetLanguage.mockRejectedValueOnce(new Error('SecureStore unavailable'));
    const approve = approveThatResolves();

    await expect(runApproveTask(approve)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('registerApproveTask', () => {
  it('registers the task under the key the Kotlin service starts', async () => {
    registerApproveTask();

    expect(mocks.registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(mocks.registerHeadlessTask.mock.calls[0]?.[0]).toBe(APPROVE_AGENT_TASK_KEY);

    await mocks.tasks.get(APPROVE_AGENT_TASK_KEY)?.();

    expect(mocks.order).toEqual(['language', 'approve']);
    expect(mocks.approveFrontAgent).toHaveBeenCalledTimes(1);
  });
});
