import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { CloudChatPage as CloudChatPageComponent } from './CloudChatPage';
import type { ChatHeader } from './ChatHeader';
import type { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import type { ConversationMessages } from './ConversationMessages';
import type { ResumeAnchor, ResumeAttemptStep } from './resume-anchor';
import type { SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';

Object.assign(globalThis, { React });

let mockSessionId: string | null = 'ses_b';
let mockAtParam: string | null = null;
let mockWorktreeId: string | null = null;
let mockChatInput: Record<string, unknown> | null = null;
let mockChatHeader: ComponentProps<typeof ChatHeader> | null = null;
let mockWorkspaceTabs: ComponentProps<typeof CloudAgentWorkspaceTabs> | null = null;
let mockAtomValues: Record<string, unknown>;
const mockSetAtom = jest.fn();
const mockRequestOlderMessages = jest.fn();
const mockPlanResumeAttempt = jest.fn((): ResumeAttemptStep => 'wait');
const mockResumeAnchorForTranscript = jest.fn((): ResumeAnchor | null => null);
const mockSendTakesOverResume = jest.fn(() => true);
const mockResizeObserve = jest.fn();
const mockResizeDisconnect = jest.fn();
const mockResizeObservers = new Map<MockResizeObserver, ResizeObserverCallback>();
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
  constructor(callback: ResizeObserverCallback) {
    mockResizeObservers.set(this, callback);
  }
  observe = mockResizeObserve;
  disconnect = () => {
    mockResizeDisconnect();
    mockResizeObservers.delete(this);
  };
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
jest.mock('./use-preview', () => ({
  ...jest.requireActual('./use-preview'),
  usePreviewUrlTemplate: () => null,
  useOpenPreview: () => ({ openPreview: jest.fn(), isOpening: false }),
}));
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
    releasePendingWorktreeOwnership: jest.fn(),
  }),
}));
jest.mock('./CloudAgentWorkspaceTabs', () => ({
  CloudAgentWorkspaceTabs: (props: ComponentProps<typeof CloudAgentWorkspaceTabs>) => {
    mockWorkspaceTabs = props;
    return null;
  },
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
  ChatHeader: (props: ComponentProps<typeof ChatHeader>) => {
    mockChatHeader = props;
    return null;
  },
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
  ConversationMessages: ({
    staticMessages,
    dynamicMessages,
  }: ComponentProps<typeof ConversationMessages>) =>
    createElement(
      'section',
      { 'data-conversation': true },
      ...[...staticMessages, ...dynamicMessages].map(message =>
        createElement(
          'div',
          { key: message.info.id, 'data-message-id': message.info.id },
          message.info.id
        )
      )
    ),
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
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const scrollTops = new WeakMap<HTMLElement, number>();
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 100 },
    offsetTop: {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.messageId ? 300 : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        scrollTops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
      },
    },
  });
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
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: MockResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('transcript phase test root missing');
  return {
    container,
    flushFrame: () => {
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach(callback => callback(0)));
    },
    resize: () => {
      act(() => {
        for (const [observer, callback] of mockResizeObservers) {
          callback([], observer);
        }
      });
    },
    cleanup: () => Object.assign(globalThis, previous),
  };
}

function anchorMessage(
  id: string,
  sessionID = 'ses_b'
): { info: Record<string, unknown>; parts: never[] } {
  return {
    info: { id, role: 'user', sessionID, parentID: sessionID, error: null },
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
    mockChatHeader = null;
    mockWorkspaceTabs = null;
    mockResizeObserve.mockClear();
    mockResizeDisconnect.mockClear();
    mockResizeObservers.clear();
    mockPlanResumeAttempt.mockReset().mockReturnValue('wait');
    mockResumeAnchorForTranscript.mockReset().mockReturnValue(null);
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
    jest.useRealTimers();
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

  it.each([null, { type: 'preparing' }, { type: 'error', message: 'Preparation failed' }])(
    'shows the assigned branch only in the footer before preparation completes (%j)',
    cloudStatus => {
      mockAtomValues.fetchedSessionData = {
        kiloSessionId: 'ses_b',
        organizationId: null,
        gitBranch: 'kilo/assigned-before-preparation',
        gitUrl: 'https://github.com/Kilo-Org/cloud.git',
        isPreparingAsync: true,
      };
      mockAtomValues.cloudStatus = cloudStatus;
      mockAtomValues.isLoading = false;

      render();

      const footer = dom.container.querySelector('[data-composer]')?.nextElementSibling;
      expect(footer?.textContent).toBe('kilo/assigned-before-preparation');
      expect(mockChatHeader).toMatchObject({
        branch: undefined,
        gitUrl: 'https://github.com/Kilo-Org/cloud.git',
      });
    }
  );

  it.each([
    { isPreparingAsync: true, cloudStatus: { type: 'ready' } },
    { isPreparingAsync: false, cloudStatus: null },
    {
      isPreparingAsync: true,
      cloudStatus: { type: 'finalizing' },
      preparationAttempts: [{ status: 'completed', steps: [] }],
    },
    {
      isPreparingAsync: true,
      cloudStatus: null,
      preparationAttempts: [{ status: 'completed', steps: [] }],
    },
  ])('passes the branch to the header after preparation completes (%j)', state => {
    mockAtomValues.fetchedSessionData = {
      kiloSessionId: 'ses_b',
      organizationId: null,
      gitBranch: 'kilo/prepared-branch',
      isPreparingAsync: state.isPreparingAsync,
    };
    mockAtomValues.cloudStatus = state.cloudStatus;
    mockAtomValues.preparationAttempts = state.preparationAttempts ?? [];
    mockAtomValues.isLoading = false;

    render();

    expect(mockChatHeader?.branch).toBe('kilo/prepared-branch');
  });

  it('does not render a placeholder when branch metadata is missing', () => {
    mockAtomValues.fetchedSessionData = {
      kiloSessionId: 'ses_b',
      organizationId: null,
      gitBranch: null,
    };
    mockAtomValues.cloudStatus = { type: 'preparing' };
    mockAtomValues.isLoading = false;

    render();

    const composer = dom.container.querySelector('[data-composer]');
    expect(composer).not.toBeNull();
    expect(composer?.nextElementSibling).toBeNull();
  });

  it('shows cached rows before metadata without allowing submission or resuming an anchor', () => {
    jest.useFakeTimers();
    mockWorktreeId = 'worktree_b';
    mockAtParam = 'msg_1';
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    mockAtomValues.canSend = false;

    render();

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).not.toBeNull();
    expect(mockWorkspaceTabs?.currentChatLoadingLabel).toBeNull();
    act(() => jest.advanceTimersByTime(999));
    expect(mockWorkspaceTabs?.currentChatLoadingLabel).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(mockWorkspaceTabs?.currentChatLoadingLabel).toBe('Refreshing session…');
    expect(mockChatInput?.disabled).toBe(true);
    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();

    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.isRefreshingCachedTranscript = false;
    render();

    expect(mockWorkspaceTabs?.currentChatLoadingLabel).toBeNull();
    expect(mockPlanResumeAttempt).toHaveBeenCalledTimes(1);
  });

  it('positions cached messages at the tail before any animation frame or refresh completes', () => {
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;

    render();

    expect(dom.container.querySelector('[data-message-id="msg_1"]')).not.toBeNull();
    expect(scrollContainer().scrollTop).toBe(900);
    expect(mockResizeObserve).toHaveBeenCalledTimes(1);
  });

  it('keeps the reader position through a delayed cached transcript refresh and queued scroll work', () => {
    jest.useFakeTimers();
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    render();
    dom.flushFrame();
    dom.flushFrame();
    dom.flushFrame();
    dom.resize();

    const scroller = scrollContainer();
    scroller.scrollTop = 400;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });

    act(() => jest.advanceTimersByTime(1500));
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.isRefreshingCachedTranscript = false;
    mockAtomValues.staticMessages = [anchorMessage('msg_1'), anchorMessage('msg_2')];
    render();
    dom.resize();
    dom.flushFrame();
    dom.flushFrame();
    act(() => jest.advanceTimersByTime(100));

    expect(scroller.scrollTop).toBe(400);
    expect(scrollButton()).not.toBeNull();
  });

  it('cancels the outgoing transcript scroll work while opening another session', () => {
    jest.useFakeTimers();
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    render();
    dom.flushFrame();

    mockSessionId = 'ses_c';
    mockAtomValues.staticMessages = [];
    mockAtomValues.isRefreshingCachedTranscript = false;
    mockAtomValues.isLoading = true;
    render();
    const scroller = scrollContainer();
    scroller.scrollTop = 200;

    dom.flushFrame();
    act(() => jest.advanceTimersByTime(100));

    expect(skeleton()).not.toBeNull();
    expect(scroller.scrollTop).toBe(200);
  });

  it('honors reader takeover immediately after a streamed transcript update', () => {
    jest.useFakeTimers();
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isLoading = false;
    render();
    dom.flushFrame();
    dom.flushFrame();
    dom.flushFrame();
    act(() => jest.advanceTimersByTime(100));
    dom.flushFrame();

    mockAtomValues.dynamicMessages = [anchorMessage('msg_streamed')];
    render();
    const scroller = scrollContainer();
    scroller.scrollTop = 400;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    dom.flushFrame();
    dom.flushFrame();
    act(() => jest.advanceTimersByTime(100));

    expect(scroller.scrollTop).toBe(400);
  });

  it('does not mistake an opening layout scroll for reader takeover of the destination anchor', () => {
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isLoading = false;
    render();
    expect(scrollContainer().scrollTop).toBe(900);

    mockSessionId = 'ses_c';
    mockAtParam = 'msg_target';
    mockAtomValues.fetchedSessionData = null;
    mockAtomValues.staticMessages = [];
    mockAtomValues.isLoading = true;
    render();
    const scroller = scrollContainer();
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 100 });
    scroller.scrollTop = 0;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    mockResumeAnchorForTranscript.mockReturnValue({ groupIndex: 0, selectorIds: ['msg_target'] });
    mockPlanResumeAttempt.mockReturnValue('scroll');
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_c', organizationId: null };
    mockAtomValues.staticMessages = [anchorMessage('msg_target', 'ses_c')];
    mockAtomValues.isLoading = false;
    render();

    expect(mockPlanResumeAttempt).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(300);
  });

  it('positions a rendered cached anchor before refresh without jumping again afterward', () => {
    mockAtParam = 'msg_1';
    mockResumeAnchorForTranscript.mockReturnValue({ groupIndex: 0, selectorIds: ['msg_1'] });
    mockPlanResumeAttempt.mockReturnValue('scroll');
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    render();

    expect(scrollContainer().scrollTop).toBe(300);
    dom.flushFrame();
    const scroller = scrollContainer();
    scroller.scrollTop = 400;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.isRefreshingCachedTranscript = false;
    render();
    dom.flushFrame();

    expect(mockPlanResumeAttempt).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(400);
  });

  it('lets the reader cancel a missing cached anchor before the refreshed transcript arrives', () => {
    mockAtParam = 'msg_missing';
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    render();
    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();
    expect(mockRequestOlderMessages).not.toHaveBeenCalled();

    const scroller = scrollContainer();
    scroller.scrollTop = 200;
    act(() => {
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.isRefreshingCachedTranscript = false;
    mockAtomValues.staticMessages = [anchorMessage('msg_missing'), anchorMessage('msg_1')];
    render();

    expect(mockPlanResumeAttempt).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(200);
  });

  it('does not follow a hidden transcript and positions it before the chat becomes visible', () => {
    mockWorktreeId = 'worktree_b';
    mockAtomValues.sessionId = 'agent_b';
    render();
    const tabs = mockWorkspaceTabs;
    if (!tabs) throw new Error('workspace tabs missing');
    act(() => tabs.onCreateTerminal());
    expect(mockWorkspaceTabs?.activeTabId).toMatch(/^terminal:/);
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
    render();

    expect(scrollContainer().scrollTop).toBe(0);
    expect(mockResizeObserve).not.toHaveBeenCalled();

    act(() => tabs.onSelectTab('chat'));

    expect(scrollContainer().scrollTop).toBe(900);
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

  it('keeps the skeleton after metadata arrives until the transcript lands', () => {
    render();
    expect(mockResizeObserve).not.toHaveBeenCalled();
    expect(skeleton()).not.toBeNull();

    act(() => {
      mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(skeleton()).not.toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).toBeNull();
    expect(mockResizeObserve).not.toHaveBeenCalled();

    act(() => {
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).not.toBeNull();
    expect(mockResizeObserve).toHaveBeenCalledTimes(1);
  });

  it('drops the skeleton for a settled empty transcript', () => {
    render();
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.isLoading = false;
    render();

    expect(skeleton()).toBeNull();
    expect(dom.container.querySelector('[data-conversation]')).not.toBeNull();
  });

  it('surfaces a matching owner error even before any messages arrive', () => {
    render();
    mockAtomValues.fetchedSessionData = { kiloSessionId: 'ses_b', organizationId: null };
    mockAtomValues.statusIndicator = { type: 'error', message: 'History unavailable' };
    render();

    expect(skeleton()).toBeNull();
    expect(alert()?.textContent).toContain('History unavailable');
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

  it('does not re-run the URL reset when a cached ?at= open finishes refreshing', () => {
    mockAtParam = 'msg_1';
    mockAtomValues.staticMessages = [anchorMessage('msg_1')];
    mockAtomValues.isRefreshingCachedTranscript = true;
    mockAtomValues.isLoading = false;
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
      mockAtomValues.isRefreshingCachedTranscript = false;
      mockAtomValues.staticMessages = [anchorMessage('msg_1')];
      mockAtomValues.isLoading = false;
      root.render(createElement(CloudChatPage, { currentUserId: 'owner' }));
    });

    expect(scrollButton()).not.toBeNull();
  });
});
