import { describe, expect, it } from '@jest/globals';
import {
  getClosedWorktreeChatTabsStorageKey,
  getClosedWorktreeChatSessionIds,
  getNextOpenChatSessionId,
  getOpenWorktreeChatSessionIds,
  parseWorktreeChatTabs,
  reduceWorktreeChatTabs,
  type WorktreeChatTabsAction,
  type WorktreeChatTabsState,
} from './worktree-chat-tabs';

const openSessionIds = Object.freeze(['session-a', 'session-b', 'session-c']);
const worktreeId = 'worktree-a';

function createState(closedSessionIds: string[] = []): WorktreeChatTabsState {
  return { closedSessionIds, sessionOrderByWorktree: {} };
}

const replaceAction = {
  type: 'replace',
  worktreeId,
  oldSessionId: 'session-b',
  newSessionId: 'new-session',
  openSessionIds,
} satisfies WorktreeChatTabsAction;

function visibleSessionIds(state: WorktreeChatTabsState, sessionIds: readonly string[]) {
  return getOpenWorktreeChatSessionIds(
    sessionIds,
    state.closedSessionIds,
    state.sessionOrderByWorktree[worktreeId]
  );
}

describe('worktree chat tabs', () => {
  it('closes a chat and reopens it without changing other closed tabs', () => {
    const closed = reduceWorktreeChatTabs(createState(['other-session']), {
      type: 'close',
      sessionId: 'session-a',
    });
    expect(closed.closedSessionIds).toEqual(['other-session', 'session-a']);
    expect(
      reduceWorktreeChatTabs(closed, { type: 'open', sessionId: 'session-a' }).closedSessionIds
    ).toEqual(['other-session']);
  });

  it('leaves the active chat open when a background chat closes', () => {
    const closed = reduceWorktreeChatTabs(createState(), {
      type: 'close',
      sessionId: 'session-b',
    });

    expect(visibleSessionIds(closed, openSessionIds)).toEqual(['session-a', 'session-c']);
  });

  it('replaces a chat by closing the old tab and reopening the new tab together', () => {
    const replaced = reduceWorktreeChatTabs(
      createState(['new-session', 'other-session']),
      replaceAction
    );

    expect(replaced.closedSessionIds).toEqual(['other-session', 'session-b']);
    expect(visibleSessionIds(replaced, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'new-session',
      'session-c',
    ]);
  });

  it.each<[string, string[]]>([
    ['session-a', ['new-session', 'session-b', 'session-c']],
    ['session-b', ['session-a', 'new-session', 'session-c']],
    ['session-c', ['session-a', 'session-b', 'new-session']],
  ])('keeps the replacement in the position of %s', (oldSessionId, expected) => {
    const replaced = reduceWorktreeChatTabs(createState(), { ...replaceAction, oldSessionId });

    expect(visibleSessionIds(replaced, [...openSessionIds, 'new-session'])).toEqual(expected);
    expect(replaced.closedSessionIds).toEqual([oldSessionId]);
  });

  it('keeps repeated replacements in the same position', () => {
    const replaced = reduceWorktreeChatTabs(createState(), replaceAction);
    const sessions = [...openSessionIds, 'new-session'];
    const replacedAgain = reduceWorktreeChatTabs(replaced, {
      ...replaceAction,
      oldSessionId: 'new-session',
      newSessionId: 'newer-session',
      openSessionIds: visibleSessionIds(replaced, sessions),
    });

    expect(visibleSessionIds(replacedAgain, [...sessions, 'newer-session'])).toEqual([
      'session-a',
      'newer-session',
      'session-c',
    ]);
    expect(replacedAgain.closedSessionIds).toEqual(['session-b', 'new-session']);
  });

  it('appends new chats without moving an earlier replacement', () => {
    const replaced = reduceWorktreeChatTabs(createState(), replaceAction);

    expect(
      visibleSessionIds(replaced, [...openSessionIds, 'new-session', 'appended-session'])
    ).toEqual(['session-a', 'new-session', 'session-c', 'appended-session']);
  });

  it('preserves the replacement order across refresh', () => {
    const replaced = reduceWorktreeChatTabs(createState(['other-session']), replaceAction);
    const restored = parseWorktreeChatTabs(JSON.stringify(replaced));

    expect(restored).toEqual(replaced);
    expect(visibleSessionIds(restored, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'new-session',
      'session-c',
    ]);
  });

  it('does not duplicate a replacement already received from session events', () => {
    const replaced = reduceWorktreeChatTabs(createState(), {
      ...replaceAction,
      openSessionIds: [...openSessionIds, 'new-session'],
    });

    expect(visibleSessionIds(replaced, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'new-session',
      'session-c',
    ]);
  });

  it('preserves tabs closed while a replacement is being created', () => {
    const closed = reduceWorktreeChatTabs(createState(), {
      type: 'close',
      sessionId: 'session-c',
    });
    const replaced = reduceWorktreeChatTabs(closed, replaceAction);

    expect(visibleSessionIds(replaced, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'new-session',
    ]);
  });

  it('keeps another worktree order unchanged', () => {
    const otherOrder = ['other-b', 'other-a'];
    const replaced = reduceWorktreeChatTabs(
      { ...createState(), sessionOrderByWorktree: { 'worktree-other': otherOrder } },
      replaceAction
    );

    expect(replaced.sessionOrderByWorktree['worktree-other']).toBe(otherOrder);
    expect(
      getOpenWorktreeChatSessionIds(
        ['other-a', 'other-b'],
        replaced.closedSessionIds,
        replaced.sessionOrderByWorktree['worktree-other']
      )
    ).toEqual(otherOrder);
  });

  it('forgets a deleted worktree without changing other worktree preferences', () => {
    const initial = {
      closedSessionIds: ['session-a', 'other-session'],
      sessionOrderByWorktree: {
        'worktree-a': ['session-a', 'session-b'],
        'worktree-other': ['other-session'],
      },
    };
    const forgotten = reduceWorktreeChatTabs(initial, {
      type: 'forgetWorktree',
      worktreeId: 'worktree-a',
      sessionIds: ['session-a', 'session-b'],
    });

    expect(forgotten).toEqual({
      closedSessionIds: ['other-session'],
      sessionOrderByWorktree: { 'worktree-other': ['other-session'] },
    });
    expect(initial.sessionOrderByWorktree['worktree-a']).toEqual(['session-a', 'session-b']);
    expect(initial.closedSessionIds).toEqual(['session-a', 'other-session']);
  });

  it('allows reopening a replaced chat without moving the replacement', () => {
    const replaced = reduceWorktreeChatTabs(createState(), replaceAction);
    const reopened = reduceWorktreeChatTabs(replaced, { type: 'open', sessionId: 'session-b' });

    expect(visibleSessionIds(reopened, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'new-session',
      'session-c',
      'session-b',
    ]);
  });

  it('keeps a same-id replacement open even if it was closed', () => {
    const replaced = reduceWorktreeChatTabs(createState(['session-a', 'other-session']), {
      ...replaceAction,
      oldSessionId: 'session-a',
      newSessionId: 'session-a',
    });

    expect(replaced.closedSessionIds).toEqual(['other-session']);
    expect(replaced.sessionOrderByWorktree).toEqual({});
  });

  it('opens the replacement if the original tab is no longer in the list', () => {
    const replaced = reduceWorktreeChatTabs(createState(['session-b']), {
      ...replaceAction,
      openSessionIds: ['session-a', 'session-c'],
    });

    expect(visibleSessionIds(replaced, [...openSessionIds, 'new-session'])).toEqual([
      'session-a',
      'session-c',
      'new-session',
    ]);
  });

  it('treats repeated close, reopen, and replace actions as no-ops', () => {
    const closed = createState(['session-a']);
    const closeAction = { type: 'close', sessionId: 'session-a' } satisfies WorktreeChatTabsAction;
    const openAction = { type: 'open', sessionId: 'session-a' } satisfies WorktreeChatTabsAction;
    const opened = reduceWorktreeChatTabs(closed, openAction);
    const replaced = reduceWorktreeChatTabs(createState(), replaceAction);

    expect(reduceWorktreeChatTabs(closed, closeAction)).toBe(closed);
    expect(reduceWorktreeChatTabs(opened, openAction)).toBe(opened);
    expect(reduceWorktreeChatTabs(replaced, replaceAction)).toBe(replaced);
    expect(
      reduceWorktreeChatTabs(replaced, {
        ...replaceAction,
        openSessionIds: ['session-a', 'new-session', 'session-c'],
      })
    ).toBe(replaced);
    expect(
      reduceWorktreeChatTabs(opened, {
        ...replaceAction,
        oldSessionId: 'session-a',
        newSessionId: 'session-a',
      })
    ).toBe(opened);
  });

  it('ignores reopening a chat that is already open', () => {
    const closed = createState(['other-session']);
    expect(reduceWorktreeChatTabs(closed, { type: 'open', sessionId: 'session-a' })).toBe(closed);
  });

  it.each<WorktreeChatTabsAction>([
    { type: 'open', sessionId: 'session-a' },
    { type: 'close', sessionId: 'session-b' },
    replaceAction,
  ])('does not mutate the input for $type', action => {
    const state = createState(['session-a', 'other-session']);
    Object.freeze(state.closedSessionIds);
    Object.freeze(state.sessionOrderByWorktree);
    Object.freeze(state);

    reduceWorktreeChatTabs(state, action);

    expect(state).toEqual(createState(['session-a', 'other-session']));
  });
});

describe('getOpenWorktreeChatSessionIds', () => {
  it('keeps the session order when no replacement order is stored', () => {
    expect(getOpenWorktreeChatSessionIds(openSessionIds, ['session-b'])).toEqual([
      'session-a',
      'session-c',
    ]);
  });

  it('ignores deleted, unknown, and closed sessions and duplicate order entries', () => {
    expect(
      getOpenWorktreeChatSessionIds(
        openSessionIds,
        ['session-b'],
        ['foreign-session', 'session-c', 'session-b', 'session-c']
      )
    ).toEqual(['session-c', 'session-a']);
  });
});

describe('getClosedWorktreeChatSessionIds', () => {
  it('orders by the latest close rather than session creation or activity', () => {
    expect(
      getClosedWorktreeChatSessionIds(openSessionIds, ['session-c', 'foreign-session', 'session-a'])
    ).toEqual(['session-a', 'session-c']);
  });

  it('moves a reopened and reclosed session to the top and preserves the order on refresh', () => {
    const reopened = reduceWorktreeChatTabs(createState(['session-b', 'session-c']), {
      type: 'open',
      sessionId: 'session-b',
    });
    const reclosed = reduceWorktreeChatTabs(reopened, { type: 'close', sessionId: 'session-b' });
    const restored = parseWorktreeChatTabs(JSON.stringify(reclosed));

    expect(getClosedWorktreeChatSessionIds(openSessionIds, restored.closedSessionIds)).toEqual([
      'session-b',
      'session-c',
    ]);
  });
});

describe('getNextOpenChatSessionId', () => {
  it('selects the first remaining chat when closing the first tab', () => {
    expect(getNextOpenChatSessionId(openSessionIds, 'session-a')).toBe('session-b');
  });

  it('selects the adjacent previous chat when closing a middle tab', () => {
    expect(getNextOpenChatSessionId(openSessionIds, 'session-b')).toBe('session-a');
  });

  it('selects the adjacent previous chat when closing the last tab', () => {
    expect(getNextOpenChatSessionId(openSessionIds, 'session-c')).toBe('session-b');
  });

  it('uses the displayed neighbor after a replacement', () => {
    const replaced = reduceWorktreeChatTabs(createState(), replaceAction);
    const visibleIds = visibleSessionIds(replaced, [...openSessionIds, 'new-session']);

    expect(getNextOpenChatSessionId(visibleIds, 'session-c')).toBe('new-session');
  });

  it('returns null when the final open chat closes', () => {
    expect(getNextOpenChatSessionId(['session-a'], 'session-a')).toBeNull();
  });

  it('ignores a chat outside the open tabs and an empty tab list', () => {
    expect(getNextOpenChatSessionId(openSessionIds, 'unrelated-session')).toBeNull();
    expect(getNextOpenChatSessionId([], 'session-a')).toBeNull();
  });

  it('does not mutate or reorder the open tab list', () => {
    getNextOpenChatSessionId(openSessionIds, 'session-b');

    expect(openSessionIds).toEqual(['session-a', 'session-b', 'session-c']);
  });
});

describe('parseWorktreeChatTabs', () => {
  it('migrates existing closed-tab preferences without reopening sessions', () => {
    expect(parseWorktreeChatTabs('["session-b","session-a","session-b","session-a"]')).toEqual(
      createState(['session-b', 'session-a'])
    );
  });

  it('validates and deduplicates closed ids and worktree orders', () => {
    expect(
      parseWorktreeChatTabs(
        JSON.stringify({
          closedSessionIds: ['session-a', 'session-a'],
          sessionOrderByWorktree: { 'worktree-a': ['session-c', 'session-b', 'session-c'] },
        })
      )
    ).toEqual({
      closedSessionIds: ['session-a'],
      sessionOrderByWorktree: { 'worktree-a': ['session-c', 'session-b'] },
    });
  });

  it.each([
    null,
    '',
    '[]',
    'not json',
    '[',
    'null',
    'true',
    '42',
    '"session-a"',
    '{}',
    '{"closedSessionIds":["session-a"]}',
    '["session-a",42]',
    '["session-a",null]',
    '["session-a",false]',
    '["session-a",{}]',
    '["session-a",["session-b"]]',
    '{"closedSessionIds":[42],"sessionOrderByWorktree":{}}',
    '{"closedSessionIds":[],"sessionOrderByWorktree":[]}',
    '{"closedSessionIds":[],"sessionOrderByWorktree":{"worktree-a":[42]}}',
    '{"closedSessionIds":[],"sessionOrderByWorktree":{"worktree-a":"session-a"}}',
  ])('returns empty preferences for missing, empty, or invalid persisted data: %s', raw => {
    expect(parseWorktreeChatTabs(raw)).toEqual(createState());
  });
});

describe('getClosedWorktreeChatTabsStorageKey', () => {
  it.each([null, undefined, ''])('does not persist without a user id: %s', userId => {
    expect(getClosedWorktreeChatTabsStorageKey(userId)).toBeNull();
    expect(getClosedWorktreeChatTabsStorageKey(userId, 'org-a')).toBeNull();
  });

  it('uses distinct stable keys for each user and organization scope', () => {
    const keys = [
      getClosedWorktreeChatTabsStorageKey('user-a'),
      getClosedWorktreeChatTabsStorageKey('user-b'),
      getClosedWorktreeChatTabsStorageKey('user-a', 'org-a'),
      getClosedWorktreeChatTabsStorageKey('user-a', 'org-b'),
      getClosedWorktreeChatTabsStorageKey('user-b', 'org-a'),
      getClosedWorktreeChatTabsStorageKey('user-a', 'personal'),
    ];

    expect(keys).not.toContain(null);
    expect(new Set(keys).size).toBe(keys.length);
    expect(getClosedWorktreeChatTabsStorageKey('user-a')).toBe(keys[0]);
    expect(getClosedWorktreeChatTabsStorageKey('user-a', 'org-a')).toBe(keys[2]);
  });

  it('prevents delimiters inside ids from colliding across scopes', () => {
    expect(getClosedWorktreeChatTabsStorageKey('user-a:organization:org-a', 'org-b')).not.toBe(
      getClosedWorktreeChatTabsStorageKey('user-a', 'org-a:organization:org-b')
    );
    expect(getClosedWorktreeChatTabsStorageKey('user:a', 'org-a')).not.toBe(
      getClosedWorktreeChatTabsStorageKey('user%3Aa', 'org-a')
    );
  });
});
