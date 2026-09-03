export const CHAT_TAB_ID = 'chat' as const;

export type TerminalTabId = `terminal:${string}`;
export type WorkspaceTabId = typeof CHAT_TAB_ID | TerminalTabId;

export type TerminalWorkspaceTab = {
  id: string;
  title: string;
  cloudAgentSessionId: string;
};

export type WorkspaceTabsState = {
  activeTabId: WorkspaceTabId;
  terminals: TerminalWorkspaceTab[];
  nextTerminalNumber: number;
};

export function terminalTabId(terminalId: string): TerminalTabId {
  return `terminal:${terminalId}`;
}

export function terminalIdFromTabId(tabId: WorkspaceTabId): string | null {
  if (!tabId.startsWith('terminal:')) return null;
  return tabId.slice('terminal:'.length);
}

export function getWorkspaceTabScope(
  worktreeId: string | null | undefined,
  kiloSessionId: string | null | undefined
): string | null {
  if (worktreeId) return `worktree:${worktreeId}`;
  if (kiloSessionId) return `session:${kiloSessionId}`;
  return null;
}

export function createWorkspaceTabsState(): WorkspaceTabsState {
  return {
    activeTabId: CHAT_TAB_ID,
    terminals: [],
    nextTerminalNumber: 1,
  };
}

export function resetWorkspaceTabs(_state: WorkspaceTabsState): WorkspaceTabsState {
  return createWorkspaceTabsState();
}

export function addTerminalTab(
  state: WorkspaceTabsState,
  terminalId: string,
  cloudAgentSessionId: string
): WorkspaceTabsState {
  const title = `Terminal ${state.nextTerminalNumber}`;

  return {
    activeTabId: terminalTabId(terminalId),
    terminals: [...state.terminals, { id: terminalId, title, cloudAgentSessionId }],
    nextTerminalNumber: state.nextTerminalNumber + 1,
  };
}

export function selectWorkspaceTab(
  state: WorkspaceTabsState,
  activeTabId: string
): WorkspaceTabsState {
  if (activeTabId === CHAT_TAB_ID) {
    return { ...state, activeTabId };
  }

  const terminal = state.terminals.find(tab => terminalTabId(tab.id) === activeTabId);
  if (!terminal) return state;

  return { ...state, activeTabId: terminalTabId(terminal.id) };
}

export function closeTerminalTab(
  state: WorkspaceTabsState,
  terminalId: string
): WorkspaceTabsState {
  const closedIndex = state.terminals.findIndex(tab => tab.id === terminalId);
  if (closedIndex === -1) return state;

  const terminals = state.terminals.filter(tab => tab.id !== terminalId);
  const closedActiveTab = state.activeTabId === terminalTabId(terminalId);

  if (!closedActiveTab) {
    return { ...state, terminals };
  }

  const fallback = terminals[Math.max(0, closedIndex - 1)] ?? null;

  return {
    activeTabId: fallback ? terminalTabId(fallback.id) : CHAT_TAB_ID,
    terminals,
    nextTerminalNumber: terminals.length === 0 ? 1 : state.nextTerminalNumber,
  };
}
