import { type UserInteractionEvent } from 'expo-widgets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import {
  GLANCEABLE_APPROVE_TARGET,
  GLANCEABLE_OPEN_TARGET,
  handleGlanceableInteraction,
} from './interaction';

const mocks = vi.hoisted(() => ({
  getInstances: vi.fn(),
  toastError: vi.fn(),
  runGlanceableApprove: vi.fn(),
  refreshGlanceableSnapshot: vi.fn(),
  readWaitingAsk: vi.fn(),
  recordWaitingAsk: vi.fn(),
  setPendingDeepLink: vi.fn(),
}));

vi.mock('./active-agents-live-activity', () => ({
  LIVE_ACTIVITY_NAME: 'ActiveAgentsLiveActivity',
  ActiveAgentsLiveActivity: { getInstances: mocks.getInstances },
}));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
  refreshGlanceableSnapshot: mocks.refreshGlanceableSnapshot,
}));
vi.mock('@/lib/glanceable/waiting-ask', () => ({
  readWaitingAsk: mocks.readWaitingAsk,
  recordWaitingAsk: mocks.recordWaitingAsk,
}));
vi.mock('@/lib/deep-link-launch', () => ({ setPendingDeepLink: mocks.setPendingDeepLink }));

/** The ActivityKit id expo-widgets renders a Live Activity's content under. */
const ACTIVITY_ID = 'activity-1';

/** Another surface: the home-screen widget reports its widget name. */
const FOREIGN_SOURCE = 'ActiveAgentsWidget';

const ASK: WaitingAsk = {
  kiloSessionId: 'session-7',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope-1',
  organizationId: 'org-1',
  userId: 'user-1',
  recordedAt: 1_750_000_000_000,
};

function event(source: string, target: string): UserInteractionEvent {
  return { source, target, timestamp: 1_750_000_000_000, type: 'ExpoWidgetsUserInteraction' };
}

const fromCard = (target: string) => event(ACTIVITY_ID, target);

describe('handleGlanceableInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstances.mockReturnValue([{ getId: () => ACTIVITY_ID }]);
    mocks.readWaitingAsk.mockResolvedValue(ASK);
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
    mocks.refreshGlanceableSnapshot.mockResolvedValue(undefined);
  });

  it('ignores a press from another layout', async () => {
    await expect(
      handleGlanceableInteraction(event(FOREIGN_SOURCE, GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('ignores a press whose source is an activity this app is not running', async () => {
    await expect(
      handleGlanceableInteraction(event('activity-9', GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('ignores a press when the running activities cannot be read', async () => {
    mocks.getInstances.mockImplementation(() => {
      throw new Error('ActivityKit unavailable');
    });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('accepts the registered name as this surface too', async () => {
    await expect(
      handleGlanceableInteraction(event('ActiveAgentsLiveActivity', GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({ kind: 'opened', href: '/(app)/agent-chat/session-7' });
  });

  it('ignores a target no button declares', async () => {
    await expect(handleGlanceableInteraction(fromCard('dismiss'))).resolves.toEqual({
      kind: 'unhandled',
    });

    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('routes Approve through the shared flow and republishes the tray', async () => {
    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'approved',
      }
    );

    expect(mocks.runGlanceableApprove).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      answeredKiloSessionId: 'session-7',
    });
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('surfaces the retryable copy and leaves Approve in place', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'retryable',
      }
    );

    expect(mocks.toastError).toHaveBeenCalledWith('glanceable.approveFailed');
    // The record stays, and the card is not republished as if it had changed.
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
  });

  it('drops an answered-elsewhere ask and still refreshes', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'gone' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'gone',
      }
    );

    expect(mocks.recordWaitingAsk).toHaveBeenCalledWith(null);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('refreshes without touching the record when nothing is approvable', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'none',
      }
    );

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Approve without a record', async () => {
    mocks.readWaitingAsk.mockResolvedValue(null);
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'none',
      }
    );

    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
  });

  it('routes Open to the recorded session', async () => {
    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'opened',
      href: '/(app)/agent-chat/session-7',
    });

    expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(
      '/(app)/agent-chat/session-7',
      'universal-link'
    );
    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
  });

  it('does nothing on Open without a record', async () => {
    mocks.readWaitingAsk.mockResolvedValue(null);

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'no_session',
    });

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('turns an escaping failure into a retryable press', async () => {
    mocks.readWaitingAsk.mockRejectedValue(new Error('storage unavailable'));

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'retryable',
      }
    );

    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
