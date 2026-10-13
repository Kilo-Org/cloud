import {
  getCloudChatLocationKey,
  getLiveSourceOpenSessionIds,
  hasLeftPendingWorktreeChatOrigin,
  releasePendingOwnership,
  shouldShowPendingWorktreeView,
  type PendingWorktreeChat,
} from './worktree-chat-pending';
import { reduceWorktreeChatTabs } from './worktree-chat-tabs';

const ORIGIN_KEY = getCloudChatLocationKey('/cloud/chat', 'ses-a', null);

function pending(overrides: Partial<PendingWorktreeChat> = {}): PendingWorktreeChat {
  return {
    tabId: 'pending-1',
    worktreeId: 'wt-1',
    sourceKiloSessionId: 'ses-a',
    placement: 'append',
    owned: true,
    resolvedKiloSessionId: null,
    originLocationKey: ORIGIN_KEY,
    ...overrides,
  };
}

describe('pending worktree chat ownership', () => {
  it('releases ownership once and never re-acquires it', () => {
    const released = releasePendingOwnership(pending());
    expect(released?.owned).toBe(false);
    expect(releasePendingOwnership(released)).toBe(released);
  });

  it('shows the pending view only for the owning, selected worktree', () => {
    expect(shouldShowPendingWorktreeView(pending(), 'wt-1')).toBe(true);
    expect(shouldShowPendingWorktreeView(pending(), 'wt-2')).toBe(false);
    expect(shouldShowPendingWorktreeView(pending({ owned: false }), 'wt-1')).toBe(false);
    expect(shouldShowPendingWorktreeView(null, 'wt-1')).toBe(false);
  });
});

describe('getLiveSourceOpenSessionIds', () => {
  it('applies the worktree order preference and drops closed tabs', () => {
    expect(
      getLiveSourceOpenSessionIds({
        worktreeSessionIds: ['ses-a', 'ses-b', 'ses-c', 'ses-d'],
        closedSessionIds: ['ses-a'],
        sessionOrder: ['ses-c', 'ses-b'],
      })
    ).toEqual(['ses-c', 'ses-b', 'ses-d']);
  });

  it('honors a reopen by dropping the id from the closed set', () => {
    expect(
      getLiveSourceOpenSessionIds({
        worktreeSessionIds: ['ses-a', 'ses-b'],
        closedSessionIds: [],
        sessionOrder: [],
      })
    ).toEqual(['ses-a', 'ses-b']);
  });

  it('preserves the live W1 order through a /new replace and leaves W2 alone', () => {
    const tabs = {
      closedSessionIds: ['ses-a'] as string[],
      sessionOrderByWorktree: { 'wt-2': ['ses-z'] } as Record<string, string[]>,
    };

    // [A,B,C] /new on B, close A, reopen D, move to W2.
    const liveW1Open = getLiveSourceOpenSessionIds({
      worktreeSessionIds: ['ses-a', 'ses-b', 'ses-c', 'ses-d'],
      closedSessionIds: ['ses-a'],
      sessionOrder: tabs.sessionOrderByWorktree['wt-1'] ?? [],
    });
    expect(liveW1Open).toEqual(['ses-b', 'ses-c', 'ses-d']);

    const next = reduceWorktreeChatTabs(tabs, {
      type: 'replace',
      worktreeId: 'wt-1',
      oldSessionId: 'ses-b',
      newSessionId: 'ses-real',
      openSessionIds: liveW1Open,
    });

    expect(next.sessionOrderByWorktree['wt-1']).toEqual(['ses-real', 'ses-c', 'ses-d']);
    expect(next.sessionOrderByWorktree['wt-2']).toEqual(['ses-z']);
    expect(next.closedSessionIds).toEqual(['ses-a', 'ses-b']);
  });
});

describe('ownership under A→B→A and dismissal', () => {
  it('does not steal focus after selecting elsewhere and returning', () => {
    let current: PendingWorktreeChat | null = pending();
    // select B, then back to A, then select a terminal — all release ownership
    current = releasePendingOwnership(current);
    expect(current?.owned).toBe(false);
    current = releasePendingOwnership(current);
    current = releasePendingOwnership(current);
    expect(shouldShowPendingWorktreeView(current, 'wt-1')).toBe(false);
  });

  it('does not steal focus after dismissal', () => {
    const dismissed = pending({ owned: false });
    expect(shouldShowPendingWorktreeView(dismissed, 'wt-1')).toBe(false);
  });
});

describe('hasLeftPendingWorktreeChatOrigin', () => {
  function at(pathname: string, sessionId: string | null, worktreeId: string | null = null) {
    return { key: getCloudChatLocationKey(pathname, sessionId, worktreeId), sessionId };
  }

  it('keeps ownership while the user stays on the origin page', () => {
    expect(hasLeftPendingWorktreeChatOrigin(pending(), at('/cloud/chat', 'ses-a'))).toBe(false);
  });

  it('releases on navigation the layout does not drive', () => {
    // Sidebar "New session".
    expect(hasLeftPendingWorktreeChatOrigin(pending(), at('/cloud', null))).toBe(true);
    // Back/Forward to another chat in the same worktree.
    expect(hasLeftPendingWorktreeChatOrigin(pending(), at('/cloud/chat', 'ses-b'))).toBe(true);
    // A redirect to the worktree page.
    expect(hasLeftPendingWorktreeChatOrigin(pending(), at('/cloud/chat', null, 'wt-1'))).toBe(true);
  });

  it("does not treat the completion's own navigation as a departure", () => {
    const resolved = pending({ resolvedKiloSessionId: 'ses-new' });
    expect(hasLeftPendingWorktreeChatOrigin(resolved, at('/cloud/chat', 'ses-new'))).toBe(false);
    expect(hasLeftPendingWorktreeChatOrigin(resolved, at('/cloud/chat', 'ses-b'))).toBe(true);
  });

  it('releases ownership when returning to the origin after creation resolves', () => {
    const resolved = pending({ resolvedKiloSessionId: 'ses-new' });
    const left = hasLeftPendingWorktreeChatOrigin(resolved, at('/cloud/chat', 'ses-a'));
    expect(left).toBe(true);
    const released = left ? releasePendingOwnership(resolved) : resolved;
    expect(shouldShowPendingWorktreeView(released, 'wt-1')).toBe(false);
  });

  it('does nothing once ownership is gone', () => {
    expect(hasLeftPendingWorktreeChatOrigin(null, at('/cloud', null))).toBe(false);
    expect(hasLeftPendingWorktreeChatOrigin(pending({ owned: false }), at('/cloud', null))).toBe(
      false
    );
  });
});
