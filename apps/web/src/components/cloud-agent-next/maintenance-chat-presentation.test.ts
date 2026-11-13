import {
  getMaintenanceChatSessions,
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

describe('maintenance chat presentation', () => {
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

  it('keeps one auto-fix tab after the attempt ends, even when old tabs were closed', () => {
    const user = session('ses_user');
    const maintenance = session('ses_maintenance', {
      chatKind: 'maintenance',
      isMaintenancePinned: false,
    });
    expect(getVisibleMaintenanceChatSessions([user, maintenance], [user.sessionId])).toEqual([
      maintenance,
      user,
    ]);
    expect(getVisibleMaintenanceChatSessions([user, maintenance])).toEqual([maintenance, user]);
  });

  it('collapses all auto-fix sessions into the latest run without changing user-tab order', () => {
    const first = session('ses_first');
    const second = session('ses_second');
    const earlier = session('ses_earlier', { chatKind: 'maintenance' });
    const latest = session('ses_latest', {
      chatKind: 'maintenance',
      createdAt: '2026-11-13T12:00:00.000Z',
    });
    expect(
      getVisibleMaintenanceChatSessions(
        [first, earlier, second, latest],
        [second.sessionId, earlier.sessionId, first.sessionId, latest.sessionId, 'unknown'],
        first.sessionId
      )
    ).toEqual([latest, second, first]);
  });

  it('shows a selected historical run in the same tab while a newer run is active', () => {
    const earlier = session('ses_earlier', { chatKind: 'maintenance' });
    const latest = session('ses_latest', {
      chatKind: 'maintenance',
      isMaintenancePinned: true,
      createdAt: '2026-11-13T12:00:00.000Z',
    });
    expect(getVisibleMaintenanceChatSessions([earlier, latest], [], earlier.sessionId)).toEqual([
      earlier,
    ]);
    expect(getVisibleMaintenanceChatSessions([earlier, latest], [], latest.sessionId)).toEqual([
      latest,
    ]);
  });

  it('does not replace a selected run when another run arrives', () => {
    const earlier = session('ses_earlier', { chatKind: 'maintenance' });
    const latest = session('ses_latest', {
      chatKind: 'maintenance',
      isMaintenancePinned: true,
      createdAt: '2026-11-13T12:00:00.000Z',
    });
    expect(getVisibleMaintenanceChatSessions([earlier], [], earlier.sessionId)).toEqual([earlier]);
    expect(getVisibleMaintenanceChatSessions([earlier, latest], [], earlier.sessionId)).toEqual([
      earlier,
    ]);
  });

  it('sorts history by creation time, not updates, with a live run first', () => {
    const earlier = session('ses_earlier', {
      chatKind: 'maintenance',
      updatedAt: '2026-11-14T12:00:00.000Z',
    });
    const latest = session('ses_latest', {
      chatKind: 'maintenance',
      createdAt: '2026-11-13 12:00:00+00',
    });
    const running = session('ses_running', {
      chatKind: 'maintenance',
      createdAt: '2026-11-11T12:00:00.000Z',
      isMaintenancePinned: true,
    });
    const sessions = [earlier, session('ses_user'), latest, running];
    expect(getMaintenanceChatSessions(sessions)).toEqual([running, latest, earlier]);
    expect(sessions[0]).toBe(earlier);
    expect(getVisibleMaintenanceChatSessions(sessions, [])).toEqual([running]);
  });

  it('falls back to the latest remaining run when the selected run is removed', () => {
    const latest = session('ses_latest', { chatKind: 'maintenance' });
    expect(getVisibleMaintenanceChatSessions([latest], [], 'ses_removed')).toEqual([latest]);
  });

  it('does not change user-only open and closed tab behavior', () => {
    const first = session('ses_first');
    const second = session('ses_second');
    expect(getVisibleMaintenanceChatSessions([first, second], [second.sessionId])).toEqual([
      second,
    ]);
    expect(getVisibleMaintenanceChatSessions([first, second], [])).toEqual([]);
    expect(getVisibleMaintenanceChatSessions([])).toEqual([]);
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
