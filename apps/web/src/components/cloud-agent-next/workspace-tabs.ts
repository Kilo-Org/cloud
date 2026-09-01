export const CHAT_TAB_ID = 'chat' as const;

export type TerminalTabId = `terminal:${string}`;
export type FileTabId = `file:${string}`;
export type WorkspaceTabId = typeof CHAT_TAB_ID | TerminalTabId | FileTabId;
export type WorktreeFileViewMode = 'diff' | 'expanded' | 'preview';

export type TerminalWorkspaceTab = {
  id: string;
  title: string;
  cloudAgentSessionId: string;
};

export type FileWorkspaceTab = {
  path: string;
  mode?: WorktreeFileViewMode;
};

export type WorkspaceTabsState = {
  activeTabId: WorkspaceTabId;
  terminals: TerminalWorkspaceTab[];
  files: FileWorkspaceTab[];
  nextTerminalNumber: number;
};

export function terminalTabId(terminalId: string): TerminalTabId {
  return `terminal:${terminalId}`;
}

export function fileTabId(path: string): FileTabId {
  return `file:${encodeURIComponent(path)}`;
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
    files: [],
    nextTerminalNumber: 1,
  };
}

export function resetWorkspaceTabs(_state: WorkspaceTabsState): WorkspaceTabsState {
  return createWorkspaceTabsState();
}

export function clearFileTabs(state: WorkspaceTabsState): WorkspaceTabsState {
  if (state.files.length === 0) return state;
  return {
    ...state,
    files: [],
    activeTabId: state.activeTabId.startsWith('file:') ? CHAT_TAB_ID : state.activeTabId,
  };
}

export function addTerminalTab(
  state: WorkspaceTabsState,
  terminalId: string,
  cloudAgentSessionId: string
): WorkspaceTabsState {
  const title = `Terminal ${state.nextTerminalNumber}`;

  return {
    ...state,
    activeTabId: terminalTabId(terminalId),
    terminals: [...state.terminals, { id: terminalId, title, cloudAgentSessionId }],
    nextTerminalNumber: state.nextTerminalNumber + 1,
  };
}

export function openFileTab(state: WorkspaceTabsState, path: string): WorkspaceTabsState {
  const activeTabId = fileTabId(path);
  if (state.files.some(tab => tab.path === path)) {
    return state.activeTabId === activeTabId ? state : { ...state, activeTabId };
  }

  return { ...state, activeTabId, files: [...state.files, { path }] };
}

export function setFileTabMode(
  state: WorkspaceTabsState,
  path: string,
  mode: WorktreeFileViewMode
): WorkspaceTabsState {
  const file = state.files.find(tab => tab.path === path);
  if (!file || file.mode === mode) return state;

  return {
    ...state,
    files: state.files.map(tab => (tab.path === path ? { ...tab, mode } : tab)),
  };
}

export function selectWorkspaceTab(
  state: WorkspaceTabsState,
  activeTabId: string
): WorkspaceTabsState {
  if (state.activeTabId === activeTabId) return state;
  if (activeTabId === CHAT_TAB_ID) return { ...state, activeTabId };

  const terminal = state.terminals.find(tab => terminalTabId(tab.id) === activeTabId);
  if (terminal) return { ...state, activeTabId: terminalTabId(terminal.id) };

  const file = state.files.find(tab => fileTabId(tab.path) === activeTabId);
  return file ? { ...state, activeTabId: fileTabId(file.path) } : state;
}

function activeTabAfterClose(
  state: WorkspaceTabsState,
  closedTabId: TerminalTabId | FileTabId
): WorkspaceTabId {
  if (state.activeTabId !== closedTabId) return state.activeTabId;

  const tabIds = [
    ...state.terminals.map(tab => terminalTabId(tab.id)),
    ...state.files.map(tab => fileTabId(tab.path)),
  ];
  const closedIndex = tabIds.indexOf(closedTabId);
  return tabIds[closedIndex - 1] ?? tabIds[closedIndex + 1] ?? CHAT_TAB_ID;
}

export function closeTerminalTab(
  state: WorkspaceTabsState,
  terminalId: string
): WorkspaceTabsState {
  if (!state.terminals.some(tab => tab.id === terminalId)) return state;

  const terminals = state.terminals.filter(tab => tab.id !== terminalId);
  return {
    ...state,
    activeTabId: activeTabAfterClose(state, terminalTabId(terminalId)),
    terminals,
    nextTerminalNumber:
      terminals.length === 0 && state.activeTabId !== CHAT_TAB_ID ? 1 : state.nextTerminalNumber,
  };
}

export function closeFileTab(state: WorkspaceTabsState, path: string): WorkspaceTabsState {
  if (!state.files.some(tab => tab.path === path)) return state;

  return {
    ...state,
    activeTabId: activeTabAfterClose(state, fileTabId(path)),
    files: state.files.filter(tab => tab.path !== path),
  };
}
