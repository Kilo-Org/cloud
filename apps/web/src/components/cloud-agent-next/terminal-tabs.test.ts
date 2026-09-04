import React, { act, createElement, useEffect, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import type { CloudChatPage as CloudChatPageComponent } from './CloudChatPage';
import type { ChatHeader } from './ChatHeader';
import type { WorktreeChangesDrawer } from './WorktreeChanges';
import type { ConversationMessages } from './ConversationMessages';
import type { StoredMessage, StoredSession } from './types';
import type { SessionCommit } from '@kilocode/cloud-agent-sdk';
import {
  CHAT_TAB_ID,
  addTerminalTab,
  closeTerminalTab,
  createWorkspaceTabsState,
  getWorkspaceTabScope,
  resetWorkspaceTabs,
  selectWorkspaceTab,
  terminalIdFromTabId,
  terminalTabId,
} from './workspace-tabs';

Object.assign(globalThis, { React });

let mockSessionId: string | null = 'ses_recent';
let mockWorktreeId: string | null = 'worktree_shared';
let mockTabs: ComponentProps<typeof CloudAgentWorkspaceTabs>;
let mockConversation: ComponentProps<typeof ConversationMessages>;
let mockAtomValues: Record<string, unknown>;
const mockClosedPtys: string[] = [];
const mockChats = [
  {
    sessionId: 'ses_recent',
    cloudAgentSessionId: 'workspace_recent',
    worktreeId: 'worktree_shared',
  },
  {
    sessionId: 'ses_historical',
    cloudAgentSessionId: 'workspace_historical',
    worktreeId: 'worktree_shared',
  },
] as StoredSession[];
const mockSetAtom = jest.fn();
const mockManager = {
  atoms: new Proxy({}, { get: (_target, key) => key }),
  switchSession: jest.fn(),
  destroy: jest.fn(),
};
const mockQueryClient = { invalidateQueries: jest.fn() };
const mockUploadEndpoint = { mutationOptions: () => ({}) };
const mockTrpc = {
  cloudAgentNext: { getAttachmentUploadUrl: mockUploadEndpoint },
  organizations: { cloudAgentNext: { getAttachmentUploadUrl: mockUploadEndpoint } },
};

jest.mock('jotai', () => ({
  useAtomValue: (key: string) => mockAtomValues[key] ?? null,
  useSetAtom: () => mockSetAtom,
}));
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSessionId ? { sessionId: mockSessionId } : {}),
}));
jest.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: jest.fn() }),
  useQueryClient: () => mockQueryClient,
}));
jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('./CloudAgentProvider', () => ({ useManager: () => mockManager }));
jest.mock('./CloudSidebarLayout', () => ({
  useWorktreeChatCreation: () => ({
    createWorktreeChat: jest.fn(),
    creatingWorktreeSourceSessionId: null,
  }),
  useWorktreeChatTabs: () => ({
    selectedWorktreeId: mockWorktreeId,
    worktreeChats: mockChats,
    openWorktreeChats: mockChats,
    closedWorktreeChats: [],
    deletingSessionIds: [],
    openSession: jest.fn(),
    closeSession: jest.fn(),
    renameSession: jest.fn(),
  }),
}));
jest.mock('./CloudAgentWorkspaceTabs', () => ({
  CloudAgentWorkspaceTabs: (props: ComponentProps<typeof CloudAgentWorkspaceTabs>) => {
    mockTabs = props;
    return null;
  },
}));
jest.mock('./CloudAgentTerminalDock', () => ({
  CloudAgentTerminalPane: ({
    cloudAgentSessionId,
    organizationId,
  }: {
    cloudAgentSessionId: string;
    organizationId?: string;
  }) => {
    useEffect(
      () => () => void mockClosedPtys.push(cloudAgentSessionId),
      [cloudAgentSessionId, organizationId]
    );
    return createElement('pre', { 'data-pty-owner': cloudAgentSessionId });
  },
}));
jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useCombinedProfiles: () => ({}),
  useProfiles: () => ({}),
  useProfile: () => ({}),
}));
jest.mock('@/hooks/useSlashCommandSets', () => ({
  useSlashCommandSets: () => ({ availableCommands: [] }),
}));
jest.mock('@/hooks/useCelebrationSound', () => ({
  useCelebrationSound: () => ({ play: jest.fn(), soundEnabled: false, setSoundEnabled: jest.fn() }),
}));
jest.mock('@/hooks/useCliSessionPresence', () => ({ useCliSessionPresence: jest.fn() }));
jest.mock('./hooks/useSessionModels', () => ({
  useSessionModels: () => ({
    modelOptions: [],
    gatewayContextLengthByModelId: new Map(),
    remoteContextLengthByProviderAndModel: new Map(),
  }),
}));
jest.mock('./older-messages-scroll', () => ({
  useOlderMessagesPagination: () => ({}),
  shouldAnnounceOlderMessagesArrival: () => false,
}));
jest.mock('./MobileSidebarToggle', () => ({ MobileSidebarToggle: () => null }));
jest.mock('./ChatHeader', () => ({
  ChatHeader: ({ onToggleChanges, changesOpen }: ComponentProps<typeof ChatHeader>) =>
    onToggleChanges
      ? createElement('button', {
          'data-changes-trigger': true,
          'aria-expanded': changesOpen,
          onClick: onToggleChanges,
        })
      : null,
}));
jest.mock('./WorktreeChanges', () => ({
  WorktreeChangesDrawer: ({
    cloudAgentSessionId,
    organizationId,
    open,
    onSelectFile,
  }: ComponentProps<typeof WorktreeChangesDrawer>) =>
    createElement('aside', {
      onClick: () => onSelectFile?.('README.md'),
      'data-changes-owner': cloudAgentSessionId,
      'data-changes-organization': organizationId ?? 'personal',
      hidden: !open,
    }),
}));
jest.mock('./WorktreeFilePane', () => ({
  WorktreeFilePane: ({
    cloudAgentSessionId,
    organizationId,
  }: {
    cloudAgentSessionId: string;
    organizationId?: string;
  }) =>
    createElement('pre', {
      'data-file-owner': cloudAgentSessionId,
      'data-file-organization': organizationId ?? 'personal',
    }),
}));
jest.mock('./ChatInput', () => ({
  ChatInput: () => createElement('input', { 'data-composer': true }),
}));
jest.mock('./ConversationMessages', () => ({
  ConversationMessages: (props: ComponentProps<typeof ConversationMessages>) => {
    mockConversation = props;
    return createElement('section', { 'data-conversation': true });
  },
}));
jest.mock('./OlderMessagesHeader', () => ({ OlderMessagesHeader: () => null }));
jest.mock('./MessageBubble', () => ({ MessageBubble: () => null }));
jest.mock('./ChildSessionDrawer', () => ({ ChildSessionDrawer: () => null }));
jest.mock('./PreparationDrawer', () => ({ PreparationDrawer: () => null }));
jest.mock('./SessionContinuationPanel', () => ({ SessionContinuationPanel: () => null }));
jest.mock('@/components/SetPageTitle', () => ({ SetPageTitle: () => null }));
jest.mock('./QuestionContext', () => ({
  QuestionContextProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('./PermissionCard', () => ({
  PermissionContextProvider: ({ children }: { children: ReactNode }) => children,
  PermissionCard: () => null,
}));
jest.mock('./SuggestionCard', () => ({
  SuggestionContextProvider: ({ children }: { children: ReactNode }) => children,
}));

function installTerminalTestDom() {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere(
    '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
  ) as { parseHTML: (html: string) => { window: typeof globalThis; document: Document } };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing terminal test root');
  return { container, cleanup: () => Object.assign(globalThis, previous) };
}

describe('cloud agent workspace terminal tabs', () => {
  it('starts on the chat tab without terminals', () => {
    expect(createWorkspaceTabsState()).toEqual({
      activeTabId: CHAT_TAB_ID,
      files: [],
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
      files: [],
      terminals: [
        { id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'cloud-agent-session-a' },
        { id: 'tab-b', title: 'Terminal 2', cloudAgentSessionId: 'cloud-agent-session-b' },
      ],
    });
  });

  it('distinguishes chat from terminal IDs', () => {
    expect(terminalIdFromTabId(CHAT_TAB_ID)).toBeNull();
    expect(terminalIdFromTabId(terminalTabId('tab-a'))).toBe('tab-a');
  });

  it('selects chat and existing terminal tabs only', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a', 'cloud-agent-session-a');

    expect(selectWorkspaceTab(state, CHAT_TAB_ID).activeTabId).toBe(CHAT_TAB_ID);
    expect(selectWorkspaceTab(state, 'changes')).toBe(state);
    expect(selectWorkspaceTab(state, 'unknown')).toBe(state);
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
      files: [],
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
      files: [],
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
      files: [],
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
      files: [],
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

describe('CloudChatPage terminal ownership across navigation', () => {
  let CloudChatPage: typeof CloudChatPageComponent;
  let dom: ReturnType<typeof installTerminalTestDom>;
  let root: Root;

  beforeAll(async () => {
    ({ CloudChatPage } = await import('./CloudChatPage'));
  });

  beforeEach(() => {
    mockSessionId = 'ses_recent';
    mockWorktreeId = 'worktree_shared';
    mockClosedPtys.length = 0;
    mockAtomValues = {
      sessionId: 'workspace_recent',
      fetchedSessionData: {
        kiloSessionId: 'ses_recent',
        organizationId: null,
        worktreeId: 'worktree_shared',
      },
      activity: { type: 'idle' },
      activeSessionType: 'cloud-agent',
      staticMessages: [],
      dynamicMessages: [],
      pendingMessages: new Map(),
      preparationAttempts: [],
      commits: [],
      chatUI: { shouldAutoScroll: false },
    };
    dom = installTerminalTestDom();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.cleanup();
  });

  function render(props: ComponentProps<typeof CloudChatPageComponent> = {}) {
    act(() => root.render(createElement(CloudChatPage, { currentUserId: 'owner', ...props })));
  }

  function openTerminal() {
    act(() => mockTabs.onCreateTerminal());
    const terminal = dom.container.querySelector('[data-pty-owner]');
    expect(terminal).not.toBeNull();
    return terminal;
  }

  function openChanges() {
    const trigger = dom.container.querySelector<HTMLButtonElement>('[data-changes-trigger]');
    if (!trigger) throw new Error('Missing changes trigger');
    act(() => trigger.click());
    const drawer = dom.container.querySelector<HTMLElement>('[data-changes-owner]');
    expect(drawer?.hidden).toBe(false);
    return drawer;
  }

  function resolveSession(worktreeId: string | null) {
    mockWorktreeId = worktreeId;
    mockAtomValues.fetchedSessionData = {
      kiloSessionId: mockSessionId,
      organizationId: null,
      worktreeId,
    };
    mockAtomValues.sessionId = `workspace_${mockSessionId}`;
    render();
  }

  it('keeps the mounted PTY and original owner through an uncached historical sibling and Back', () => {
    render();
    const terminal = openTerminal();
    mockSessionId = 'ses_historical';
    mockWorktreeId = null;
    render();
    expect(mockTabs.terminals).toHaveLength(1);
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockClosedPtys).toEqual([]);

    mockAtomValues.fetchedSessionData = null;
    mockAtomValues.sessionId = null;
    render();
    resolveSession('worktree_shared');
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockTabs.terminals[0]?.cloudAgentSessionId).toBe('workspace_recent');
    expect(mockTabs.activeTabId).toBe(CHAT_TAB_ID);

    mockSessionId = 'ses_recent';
    mockWorktreeId = null;
    render();
    resolveSession('worktree_shared');
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockClosedPtys).toEqual([]);
  });

  it('keeps terminals when the final chat closes to the worktree-only route', () => {
    render();
    const terminal = openTerminal();
    mockSessionId = null;
    mockAtomValues.fetchedSessionData = null;
    mockAtomValues.sessionId = null;
    render();

    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockTabs.terminals[0]?.cloudAgentSessionId).toBe('workspace_recent');
    expect(mockClosedPtys).toEqual([]);
  });

  it('keeps the conversation, composer and PTY mounted while files are selected and clears files before sibling identity resolves', () => {
    render();
    const conversation = dom.container.querySelector('[data-conversation]');
    const composer = dom.container.querySelector('[data-composer]');
    const terminal = openTerminal();
    const drawer = openChanges();
    act(() => drawer?.click());
    expect(dom.container.querySelector('[data-file-owner]')?.getAttribute('data-file-owner')).toBe(
      'workspace_recent'
    );
    expect(dom.container.querySelector('[data-composer]')).toBe(composer);
    expect(dom.container.querySelector('[data-conversation]')).toBe(conversation);
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    mockSessionId = 'ses_historical';
    render();
    expect(dom.container.querySelector('[data-file-owner]')).toBeNull();
    expect(mockTabs.files).toEqual([]);
    resolveSession('worktree_shared');
    expect(dom.container.querySelector('[data-file-owner]')).toBeNull();
    const siblingDrawer = openChanges();
    act(() => siblingDrawer?.click());
    expect(dom.container.querySelector('[data-file-owner]')?.getAttribute('data-file-owner')).toBe(
      'workspace_ses_historical'
    );
    render({ organizationId: 'organization-a' });
    expect(dom.container.querySelector('[data-file-owner]')).toBeNull();
    expect(mockTabs.files).toEqual([]);
  });

  function receiveCommit() {
    const commitHash = 'a'.repeat(40);
    const commits: SessionCommit[] = [
      {
        commitHash,
        commitMessage: 'Actual commit',
        messageId: 'assistant',
        userMessageId: 'user',
        committedAt: '2026-09-01T10:00:00.000Z',
        pushStatus: 'pushed',
      },
    ];
    mockAtomValues.commits = commits;
    mockAtomValues.dynamicMessages = [
      {
        info: {
          id: 'assistant',
          sessionID: 'ses_recent',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          parentID: 'user',
          modelID: 'test',
          providerID: 'test',
          mode: 'code',
          agent: 'code',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ] satisfies StoredMessage[];
    render();
    const anchors = mockConversation.commitsAfterMessage;
    expect(anchors?.get('assistant')).toEqual(commits);
    render();
    expect(mockConversation.commitsAfterMessage).toBe(anchors);
    return anchors;
  }

  it('adds commit metadata without changing workspace tabs, chats, the draft, or the mounted PTY', () => {
    render();
    const composer = dom.container.querySelector<HTMLInputElement>('[data-composer]');
    if (!composer) throw new Error('Missing composer');
    composer.value = 'Unsent draft';
    const conversation = dom.container.querySelector('[data-conversation]');
    const terminal = openTerminal();
    const tabId = mockTabs.activeTabId;
    const terminals = mockTabs.terminals;
    const files = mockTabs.files;
    const switches = mockManager.switchSession.mock.calls.length;
    receiveCommit();
    expect(mockTabs.activeTabId).toBe(tabId);
    expect(mockTabs.terminals).toBe(terminals);
    expect(mockTabs.files).toBe(files);
    expect(mockTabs).not.toHaveProperty('commits');
    expect(dom.container.querySelector('[data-composer]')).toBe(composer);
    expect(composer.value).toBe('Unsent draft');
    expect(dom.container.querySelector('[data-conversation]')).toBe(conversation);
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockSessionId).toBe('ses_recent');
    expect(mockManager.switchSession.mock.calls.length).toBe(switches);
    expect(mockClosedPtys).toEqual([]);
  });

  it('withholds old commit metadata before sibling atoms resolve while preserving the worktree PTY', () => {
    render();
    const terminal = openTerminal();
    receiveCommit();
    mockSessionId = 'ses_historical';
    render();
    expect(mockConversation.commitsAfterMessage?.size).toBe(0);
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
  });

  it('withholds commit metadata when the organization does not match the loaded session', () => {
    receiveCommit();
    render({ organizationId: 'another-organization' });
    expect(mockConversation.commitsAfterMessage?.size).toBe(0);
  });

  it('withholds commit metadata when access becomes read-only', () => {
    receiveCommit();
    mockAtomValues.isReadOnly = true;
    render();
    expect(mockConversation.commitsAfterMessage?.size).toBe(0);
  });

  it('scopes changes to each sibling control session without replacing its worktree terminal', () => {
    render();
    const terminal = openTerminal();
    const activeTabId = mockTabs.activeTabId;
    const changes = openChanges();
    expect(changes?.getAttribute('data-changes-owner')).toBe('workspace_recent');
    expect(mockTabs.activeTabId).toBe(activeTabId);

    mockSessionId = 'ses_historical';
    render();
    expect(dom.container.querySelector('[data-changes-owner]')).toBeNull();
    expect(dom.container.querySelector('[data-changes-trigger]')).toBeNull();

    resolveSession('worktree_shared');
    expect(dom.container.querySelector<HTMLElement>('[data-changes-owner]')?.hidden).toBe(true);
    const siblingChanges = openChanges();
    expect(siblingChanges?.getAttribute('data-changes-owner')).toBe('workspace_ses_historical');
    expect(siblingChanges).not.toBe(changes);
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockClosedPtys).toEqual([]);
  });

  it('clears changes when the last chat closes before its session atoms are cleared', () => {
    render();
    const terminal = openTerminal();
    openChanges();

    mockSessionId = null;
    render();
    expect(dom.container.querySelector('[data-changes-owner]')).toBeNull();
    expect(dom.container.querySelector('[data-changes-trigger]')).toBeNull();
    expect(dom.container.querySelector('[data-pty-owner]')).toBe(terminal);
    expect(mockClosedPtys).toEqual([]);

    mockSessionId = 'ses_recent';
    render();
    expect(dom.container.querySelector<HTMLElement>('[data-changes-owner]')?.hidden).toBe(true);
  });

  it('keeps changes hidden across organization navigation until matching session data resolves', () => {
    render();
    const personalChanges = openChanges();
    expect(personalChanges?.getAttribute('data-changes-organization')).toBe('personal');

    render({ organizationId: 'organization-a' });
    expect(dom.container.querySelector('[data-changes-owner]')).toBeNull();
    expect(dom.container.querySelector('[data-changes-trigger]')).toBeNull();

    mockAtomValues.fetchedSessionData = {
      kiloSessionId: mockSessionId,
      organizationId: 'organization-a',
      worktreeId: mockWorktreeId,
    };
    render({ organizationId: 'organization-a' });
    expect(dom.container.querySelector<HTMLElement>('[data-changes-owner]')?.hidden).toBe(true);
    const organizationChanges = openChanges();
    expect(organizationChanges?.getAttribute('data-changes-organization')).toBe('organization-a');
    expect(organizationChanges).not.toBe(personalChanges);
  });

  it.each(['worktree_other', null])(
    'closes the original PTY only after a different destination resolves to %s',
    destinationWorktreeId => {
      render();
      openTerminal();
      mockSessionId = 'ses_other';
      mockWorktreeId = null;
      mockAtomValues.fetchedSessionData = null;
      render();
      expect(mockClosedPtys).toEqual([]);

      resolveSession(destinationWorktreeId);
      expect(mockTabs.terminals).toEqual([]);
      expect(dom.container.querySelector('[data-pty-owner]')).toBeNull();
      expect(mockClosedPtys).toEqual(['workspace_recent']);
    }
  );

  it.each([{ currentUserId: 'another-owner' }, { organizationId: 'another-organization' }])(
    'resets immediately across tenant changes even while identity is unresolved: %j',
    props => {
      render();
      openTerminal();
      mockSessionId = 'ses_unresolved';
      mockWorktreeId = null;
      render(props);

      expect(dom.container.querySelector('[data-pty-owner]')).toBeNull();
      expect(mockClosedPtys).toEqual(['workspace_recent']);
    }
  );

  it('resolves a direct link before opening terminals and resets when leaving all chats', () => {
    mockWorktreeId = null;
    mockAtomValues.fetchedSessionData = null;
    mockAtomValues.sessionId = null;
    render();
    resolveSession('worktree_shared');
    openTerminal();
    expect(mockTabs.terminals).toHaveLength(1);

    mockSessionId = null;
    mockWorktreeId = null;
    mockAtomValues.fetchedSessionData = null;
    mockAtomValues.sessionId = null;
    render();
    expect(dom.container.querySelector('[data-pty-owner]')).toBeNull();
    expect(mockClosedPtys).toEqual(['workspace_ses_recent']);
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
