import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleApproveTask, SESSION_DISMISS_ACTION } from './approve-task';

const mocks = vi.hoisted(() => ({
  unfollowDismissedSession: vi.fn(async () => {
    await Promise.resolve();
  }),
  approveFollowedSession: vi.fn(async () => {
    await Promise.resolve();
    return true;
  }),
  readWaitingAsk: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
  runGlanceableApprove: vi.fn(),
}));

vi.mock('@/lib/glanceable/session-follow', () => ({
  unfollowDismissedSession: mocks.unfollowDismissedSession,
  approveFollowedSession: mocks.approveFollowedSession,
}));
vi.mock('@/lib/glanceable/waiting-ask', () => ({
  readWaitingAsk: mocks.readWaitingAsk,
  recordWaitingAsk: vi.fn(),
}));
vi.mock('@/lib/glanceable/persist', () => ({
  restorePersistedGlanceable: vi.fn(async () => {
    await Promise.resolve();
  }),
}));
vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
}));
vi.mock('@/lib/glanceable/apply-stored-language', () => ({
  applyStoredLanguage: vi.fn(async () => {
    await Promise.resolve();
  }),
}));
vi.mock('@/lib/glanceable/republish-ask', () => ({ republishAnsweredAsk: vi.fn() }));
vi.mock('./android-sink', () => ({
  androidSink: {},
  setGlanceableActionNotice: vi.fn(),
  setGlanceableActionApproving: vi.fn(),
  renderStoredSnapshotWithNotice: vi.fn(),
}));
vi.mock('@/lib/needs-input-notification', () => ({ dismissNeedsInputNotification: vi.fn() }));
vi.mock('react-native', () => ({ AppRegistry: { registerHeadlessTask: vi.fn() } }));
vi.mock('./register', () => ({
  applyWidgetLanguage: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleApproveTask for a session notification', () => {
  it('unfollows a dismissed session and answers nothing', async () => {
    await handleApproveTask({ action: SESSION_DISMISS_ACTION, session_id: 'session-1' });

    expect(mocks.unfollowDismissedSession).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(mocks.approveFollowedSession).not.toHaveBeenCalled();
    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    // The aggregate card's recorded ask is never read for a dismissal.
    expect(mocks.readWaitingAsk).not.toHaveBeenCalled();
  });

  it('never rejects when the row delete fails, so the worker still completes', async () => {
    mocks.unfollowDismissedSession.mockRejectedValueOnce(new Error('offline'));

    await expect(
      handleApproveTask({ action: SESSION_DISMISS_ACTION, session_id: 'session-1' })
    ).resolves.toBeUndefined();
  });

  it('answers the explicit request of a session Approve', async () => {
    await handleApproveTask({
      action: 'com.kilocode.activeagentsliveupdate.action.APPROVE',
      session_id: 'session-1',
      approval_key: 'a'.repeat(64),
    });

    expect(mocks.approveFollowedSession).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'a'.repeat(64)
    );
    expect(mocks.unfollowDismissedSession).not.toHaveBeenCalled();
  });

  it('does not treat a dismissal with no session as anything', async () => {
    await handleApproveTask({ action: SESSION_DISMISS_ACTION });

    expect(mocks.unfollowDismissedSession).not.toHaveBeenCalled();
  });
});
