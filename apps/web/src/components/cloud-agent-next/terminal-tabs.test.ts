import {
  CHAT_TAB_ID,
  addTerminalTab,
  closeTerminalTab,
  createWorkspaceTabsState,
  getWorkspaceTabScope,
  resetWorkspaceTabs,
  selectWorkspaceTab,
  terminalTabId,
} from './terminal-tabs';

describe('cloud agent workspace terminal tabs', () => {
  it('starts on the chat tab without terminals', () => {
    expect(createWorkspaceTabsState()).toEqual({
      activeTabId: CHAT_TAB_ID,
      terminals: [],
      nextTerminalNumber: 1,
    });
  });

  it('adds terminal tabs with stable ids, human labels, and their original session owners', () => {
    const first = addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a');
    const second = addTerminalTab(first, 'tab-b', 'cloud-agent-session-b');

    expect(second).toEqual({
      activeTabId: terminalTabId('tab-b'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'cloud-agent-session-a' },
        { id: 'tab-b', title: 'Terminal 2', cloudAgentSessionId: 'cloud-agent-session-b' },
      ],
    });
  });

  it('selects chat and existing terminal tabs only', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a');

    expect(selectWorkspaceTab(state, CHAT_TAB_ID).activeTabId).toBe(CHAT_TAB_ID);
    expect(selectWorkspaceTab(state, terminalTabId('tab-a')).activeTabId).toBe(
      terminalTabId('tab-a')
    );
    expect(selectWorkspaceTab(state, terminalTabId('missing'))).toBe(state);
  });

  it('keeps the current tab when a background terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(
        addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a'),
        'tab-b',
        'cloud-agent-session-b'
      ),
      terminalTabId('tab-a')
    );

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'cloud-agent-session-a' },
      ],
    });
  });

  it('activates the left neighbor when the active terminal closes', () => {
    const state = addTerminalTab(
      addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a'),
      'tab-b',
      'cloud-agent-session-b'
    );

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'cloud-agent-session-a' },
      ],
    });
  });

  it('activates the right neighbor when the first active terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(
        addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a'),
        'tab-b',
        'cloud-agent-session-b'
      ),
      terminalTabId('tab-a')
    );

    expect(closeTerminalTab(state, 'tab-a')).toEqual({
      activeTabId: terminalTabId('tab-b'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-b', title: 'Terminal 2', cloudAgentSessionId: 'cloud-agent-session-b' },
      ],
    });
  });

  it('preserves chat selection and numbering when its background terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a'),
      CHAT_TAB_ID
    );

    expect(closeTerminalTab(state, 'tab-a')).toEqual({
      activeTabId: CHAT_TAB_ID,
      terminals: [],
      nextTerminalNumber: 2,
    });
  });

  it('ignores attempts to close a terminal that does not exist', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a');

    expect(closeTerminalTab(state, 'missing')).toBe(state);
  });

  it('returns to chat when the last terminal closes or the session resets', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a');

    expect(closeTerminalTab(state, 'tab-a')).toEqual(createWorkspaceTabsState());
    expect(resetWorkspaceTabs(state)).toEqual(createWorkspaceTabsState());
  });
});

describe('getWorkspaceTabScope', () => {
  it('keeps sibling chats in the same worktree scope', () => {
    const first = getWorkspaceTabScope('worktree-a', 'session-a');
    const second = getWorkspaceTabScope('worktree-a', 'session-b');

    expect(first).toBe('worktree:worktree-a');
    expect(second).toBe(first);
  });

  it('isolates distinct worktrees even when their session identity matches', () => {
    expect(getWorkspaceTabScope('worktree-a', 'shared-session')).toBe('worktree:worktree-a');
    expect(getWorkspaceTabScope('worktree-b', 'shared-session')).toBe('worktree:worktree-b');
  });

  it('isolates standalone sessions from each other and grouped identities', () => {
    expect(getWorkspaceTabScope(null, 'session-a')).toBe('session:session-a');
    expect(getWorkspaceTabScope(undefined, 'session-b')).toBe('session:session-b');
    expect(getWorkspaceTabScope('shared-id', 'shared-id')).toBe('worktree:shared-id');
    expect(getWorkspaceTabScope(null, 'shared-id')).toBe('session:shared-id');
  });

  it('returns null when no worktree or standalone session is available', () => {
    expect(getWorkspaceTabScope(null, null)).toBeNull();
    expect(getWorkspaceTabScope(undefined, undefined)).toBeNull();
    expect(getWorkspaceTabScope(null, undefined)).toBeNull();
    expect(getWorkspaceTabScope(undefined, null)).toBeNull();
  });
});
