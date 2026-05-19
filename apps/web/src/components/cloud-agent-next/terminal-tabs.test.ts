import {
  CHAT_TAB_ID,
  addTerminalTab,
  closeTerminalTab,
  createWorkspaceTabsState,
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

  it('adds terminal tabs with stable ids and human labels', () => {
    const first = addTerminalTab(createWorkspaceTabsState(), 'tab-a');
    const second = addTerminalTab(first, 'tab-b');

    expect(second).toEqual({
      activeTabId: terminalTabId('tab-b'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-a', title: 'Terminal 1' },
        { id: 'tab-b', title: 'Terminal 2' },
      ],
    });
  });

  it('selects chat and existing terminal tabs only', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a');

    expect(selectWorkspaceTab(state, CHAT_TAB_ID).activeTabId).toBe(CHAT_TAB_ID);
    expect(selectWorkspaceTab(state, terminalTabId('tab-a')).activeTabId).toBe(
      terminalTabId('tab-a')
    );
    expect(selectWorkspaceTab(state, terminalTabId('missing'))).toBe(state);
  });

  it('keeps the current tab when a background terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b'),
      terminalTabId('tab-a')
    );

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [{ id: 'tab-a', title: 'Terminal 1' }],
    });
  });

  it('activates the left neighbor when the active terminal closes', () => {
    const state = addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b');

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [{ id: 'tab-a', title: 'Terminal 1' }],
    });
  });

  it('returns to chat when the last terminal closes or the session resets', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a');

    expect(closeTerminalTab(state, 'tab-a')).toEqual(createWorkspaceTabsState());
    expect(resetWorkspaceTabs(state)).toEqual(createWorkspaceTabsState());
  });
});
