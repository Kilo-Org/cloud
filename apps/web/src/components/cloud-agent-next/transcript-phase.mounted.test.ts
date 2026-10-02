import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { CloudChatPage as CloudChatPageComponent } from './CloudChatPage';
import type { ChatHeader } from './ChatHeader';
import type { SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';

Object.assign(globalThis, { React });

let mockSessionId: string | null = 'ses_b';
let mockAtParam: string | null = null;
let mockWorktreeId: string | null = null;
let mockChatInput: Record<string, unknown> | null = null;
let mockAtomValues: Record<string, unknown>;
const mockSetAtom = jest.fn();
const mockRequestOlderMessages = jest.fn();
const mockPlanResumeAttempt = jest.fn(() => 'wait');
const mockResumeAnchorForTranscript = jest.fn(() => null);
const mockSendTakesOverResume = jest.fn(() => true);
const mockResizeObserve = jest.fn();
const mockResizeDisconnect = jest.fn();
const mockManager = {
  atoms: new Proxy({}, { get: (_target, key) => key }),
  switchSession: jest.fn(),
  destroy: jest.fn(),
  send: jest.fn(async () => true),
  loadOlderMessages: jest.fn(),
  trimRetainedHistory: jest.fn(),
  setRemoteModelOverride: jest.fn(),
  interrupt: jest.fn(),
  answerQuestion: jest.fn(),
  rejectQuestion: jest.fn(),
  respondToPermission: jest.fn(),
  acceptSuggestion: jest.fn(),
  dismissSuggestion: jest.fn(),
};
const mockQueryClient = { invalidateQueries: jest.fn() };
const mockUploadEndpoint = { mutationOptions: () => ({}) };
const mockTrpc = {
  cloudAgentNext: { getAttachmentUploadUrl: mockUploadEndpoint },
  organizations: { cloudAgentNext: { getAttachmentUploadUrl: mockUploadEndpoint } },
};

class MockResizeObserver {
  observe = mockResizeObserve;
  disconnect = mockResizeDisconnect;
  unobserve = jest.fn();
}

jest.mock('jotai', () => ({
  useAtomValue: (key: string) => mockAtomValues[key] ?? null,
  useSetAtom: () => mockSetAtom,
}));
jest.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams({
      ...(mockSessionId ? { sessionId: mockSessionId } : {}),
      ...(mockAtParam ? { at: mockAtParam } : {}),
    }),
}));
jest.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: jest.fn() }),
  useQueryClient: () => mockQueryClient,
}));
jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('./CloudAgentProvider', () => ({
  useManager: () => mockManager,
  useCloudAgent: () => ({}),
}));
jest.mock('./resume-anchor', () => ({
  planResumeAttempt: () => mockPlanResumeAttempt(),
  resumeAnchorForTranscript: () => mockResumeAnchorForTranscript(),
  sendTakesOverResume: () => mockSendTakesOverResume(),
}));
jest.mock('./useWorktreeReview', () => ({ useWorktreeReview: () => ({ scope: null }) }));
jest.mock('./WorktreeReviewDialog', () => ({ WorktreeReviewDialog: () => null }));
jest.mock('./CloudSidebarLayout', () => ({
  useWorktreeChatCreation: () => ({
    createWorktreeChat: jest.fn(),
    creatingWorktreeSourceSessionId: null,
  }),
  useWorktreeChatTabs: () => ({
    selectedWorktreeId: mockWorktreeId,
    worktreeChats: [],
    openWorktreeChats: [],
    closedWorktreeChats: [],
    deletingSessionIds: [],
    openSession: jest.fn(),
    closeSession: jest.fn(),
    renameSession: jest.fn(),
  }),
}));
jest.mock('./CloudAgentWorkspaceTabs', () => ({
  CloudAgentWorkspaceTabs: () => null,
}));
jest.mock('./CloudAgentTerminalDock', () => ({ CloudAgentTerminalPane: () => null }));
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
  OLDER_MESSAGES_NEAR_BOTTOM_PX: 100,
  useOlderMessagesPagination: () => ({
    requestOlderMessages: mockRequestOlderMessages,
    tryLoadOlderFromScroll: jest.fn(),
  }),
  shouldAnnounceOlderMessagesArrival: () => false,
}));
jest.mock('./MobileSidebarToggle', () => ({ MobileSidebarToggle: () => null }));
jest.mock('./ChatHeader', () => ({
  ChatHeader: (_props: ComponentProps<typeof ChatHeader>) => null,
}));
jest.mock('./WorktreeChanges', () => ({ WorktreeChangesView: () => null }));
jest.mock('./WorktreeFilePane', () => ({ WorktreeFilePane: () => null }));
jest.mock('./ChatInput', () => ({
  ChatInput: (props: Record<string, unknown>) => {
    mockChatInput = props;
    return createElement('input', { 'data-composer': true });
  },
}));
jest.mock('./ConversationMessages', () => ({
  ConversationMessages: () => createElement('section', { 'data-conversation': true }),
}));
jest.mock('./OlderMessagesHeader', () => ({ OlderMessagesHeader: () => null }));
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
jest.mock('./SessionStatusIndicator', () => ({
  SessionStatusIndicator: ({ indicator }: { indicator: SessionStatusIndicatorType }) =>
    createElement('span', { 'data-status-indicator': indicator.type }, indicator.message),
}));

function installDom() {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: (html: string) => { window: typeof globalThis } } => {
    try {
      return requireFromHere('linkedom') as {
        parseHTML: (html: string) => { window: typeof globalThis };
      };
    } catch {
      return requireFromHere(
        '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: (html: string) => { window: typeof globalThis } };
    }
  };
  const { window } = loadLinkedom().parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const document = window.document;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: MockResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('transcript phase test root missing');
  return { container, cleanup: () => Object.assign(globalThis, previous) };
}

function anchorMessage(id: string): { info: Record<string, unknown>; parts: never[] } {
  return {
    info: { id, role: 'user', sessionID: 'ses_b', parentID: 'ses_b', error: null },
    parts: [],
  };
}

describe('CloudChatPage route-aware transcript phase', () => {
  let CloudChatPage: typeof CloudChatPageComponent;
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(async () => {
    ({ CloudChatPage } = await import('./CloudChatPage'));
  });

  beforeEach(() => {
    mockSessionId = 'ses_b';
    mockAtParam = null;
    mockWorktreeId = null;
    mockChatInput = null;
    mockResizeObserve.mockClear();
    mockResizeDisconnect.mockClear();
    mockPlanResumeAttempt.mockClear();
    mockResumeAnchorForTranscript.mockClear();
    mockRequestOlderMessages.mockClear();
    mockSetAtom.mockClear();
    mockAtomValues = {
      sessionId: null,
      fetchedSessionData: null,
      activity: { type: 'idle' },
      activeSessionType: 'cloud-agent',
      staticMessages: [],
      dynamicMessages: [],
      pendingMessages: new Map(),
      preparationAttempts: [],
      commits: [],
      chatUI: { shouldAutoScroll: true },
      isLoading: true,
    };
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.cleanup();
  });

  function render(): void {
    act(() => root.render(createElement(CloudChatPage, { currentUserId: 'owner' })));
  }

  function skeleton(): Element | null {
    return dom.container.querySelector('[data-slot="skeleton"]');
  }

  function alert(): Element | null {
    return dom.container.querySelector('[role="alert"]');
  }

  function scrollButton(): Element | null {
    return (
      Array.from(dom.container.querySelectorAll('button')).find(button =>
        button.className.includes('bottom-4')
      ) ?? null
    );
  }

  function scrollContainer(): HTMLElement {
    const container = dom.container.querySelector<HTMLElement>('.overflow-y-auto');
    if (!container) throw new Error('transcript scroll container missing');
    return container;
  }

  it('renders the skeleton instead of a stale error while the started open is loading', () => {
    mockAtomValues.statusIndicator = { type: 'error', message: 'Stale failure' };

    render();

    expect(skeleton()).not.toBeNull();
    expect(dom.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
    const status = dom.container.querySelector('[role="status"][aria-busy="true"]');
    expect(status?.textContent).toContain('Loading session…');
    expect(alert()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).toBeNull();
    expect(mockChatInput?.placeholder).toBe('Loading session…');
  });

  it('shows the existing error alert and drops prior rows once the started open fails', () => {
    render();
    expect(skeleton()).not.toBeNull();

    act(() => {
      mockAtomValues.statusIndicator = { type: 'error', message: 'Failed to open' };
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).toBeNull();
    expect(alert()?.textContent).toContain('Failed to open');
  });

  it('shows the transcript and starts observing its content once the open is live', () => {
    render();
    expect(mockResizeObserve).not.toHaveBeenCalled();
    expect(skeleton()).not.toBeNull();

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).not.toBeNull();
    expect(mockResizeObserve).toHaveBeenCalledTimes(1);
  });

  it('renders the transcript and composer error alert when the owner matches an error while loading', () => {
    render();
    expect(skeleton()).not.toBeNull();

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.statusIndicator = { type: 'error', message: 'Replay disconnected' };
      mockAtomValues.isLoading = true;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).not.toBeNull();
    expect(alert()?.textContent).toContain('Replay disconnected');
  });

  it('does not resume the ?at= anchor until the requested session owns the transcript', () => {
    mockAtParam = 'msg_1';

    render();
    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();

    act(() => {
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(mockPlanResumeAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not run the ?at= resume or move the viewport until the open is live', () => {
    mockAtParam = 'msg_1';

    render();

    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();
    expect(scrollContainer().scrollTop ?? 0).toBe(0);

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(mockPlanResumeAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not re-run the URL reset when a ?at= open becomes live', () => {
    mockAtParam = 'msg_1';
    render();

    const scroller = scrollContainer();
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    expect(scrollButton()).not.toBeNull();

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(scrollButton()).not.toBeNull();
  });
});
