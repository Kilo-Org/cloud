import {
  getVisibleMaintenanceChatSessions,
  isMaintenanceChatPinned,
} from './maintenance-chat-presentation';
import type { StoredSession } from './types';

const session = (id: string, patch: Partial<StoredSession> = {}): StoredSession => ({
  sessionId: id,
  repository: 'example/repository',
  prompt: id,
  mode: 'code',
  model: '',
  status: 'active',
  createdAt: '2026-11-12T12:00:00.000Z',
  updatedAt: '2026-11-12T12:00:00.000Z',
  worktreeId: 'worktree-example',
  messages: [],
  ...patch,
});

describe('maintenance chat pinning', () => {
  it('shows the live maintenance chat first even when its tab was closed', () => {
    const user = session('ses_user');
    const maintenance = session('ses_maintenance', {
      chatKind: 'maintenance',
      isMaintenancePinned: true,
    });
    expect(getVisibleMaintenanceChatSessions([user, maintenance], [user.sessionId])).toEqual([
      maintenance,
      user,
    ]);
  });

  it('restores normal ordering and closed-tab behavior when the attempt ends', () => {
    const user = session('ses_user');
    const maintenance = session('ses_maintenance', {
      chatKind: 'maintenance',
      isMaintenancePinned: false,
    });
    expect(getVisibleMaintenanceChatSessions([user, maintenance], [user.sessionId])).toEqual([
      user,
    ]);
    expect(getVisibleMaintenanceChatSessions([user, maintenance])).toEqual([user, maintenance]);
  });

  it('never pins from platform, chat status, or a user-chat pin flag', () => {
    expect(
      isMaintenanceChatPinned(session('ses_user', { chatKind: 'user', isMaintenancePinned: true }))
    ).toBe(false);
    expect(
      isMaintenanceChatPinned(
        session('ses_running', { createdOnPlatform: 'cloud-agent-web', sessionStatus: 'busy' })
      )
    ).toBe(false);
    expect(
      isMaintenanceChatPinned(
        session('ses_question', { chatKind: 'maintenance', sessionStatus: 'question' })
      )
    ).toBe(false);
  });

  it('does not duplicate a pinned chat that is already open', () => {
    const maintenance = session('ses_maintenance', {
      chatKind: 'maintenance',
      isMaintenancePinned: true,
    });
    expect(getVisibleMaintenanceChatSessions([maintenance], [maintenance.sessionId])).toEqual([
      maintenance,
    ]);
  });
});
