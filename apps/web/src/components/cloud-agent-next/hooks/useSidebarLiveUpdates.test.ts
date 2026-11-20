import React, { act, createElement, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import type { UserWebSessionEventData, UserWebSessionEventName } from '@kilocode/cloud-agent-sdk';
import type { WorkspaceSummary } from './useWorkspaceSummaries';
import { workspaceSummaryFixture } from './workspace-summary-test-fixtures';
import { useSidebarLiveUpdates } from './useSidebarLiveUpdates';
import { WORKSPACE_REFRESH_TIMEOUT_MS } from './workspace-refresh';

const WORKTREE_A = 'worktree_11111111-1111-4111-8111-111111111111';
const WORKTREE_B = 'worktree_22222222-2222-4222-8222-222222222222';
const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
const OTHER_ORGANIZATION = '44444444-4444-4444-8444-444444444444';
const REPOSITORY = 'https://github.com/example/repository.git';
const TIME = '2026-11-16T12:00:00.000Z';
const NEWER = '2026-11-16T12:00:02.000Z';
const OLDER = '2026-11-16T12:00:01.000Z';
type Options = Parameters<typeof useSidebarLiveUpdates>[0];
type SessionRow = UserWebSessionEventData<'session.created'>['session'];
const mockNetwork = {
  list: jest.fn(),
  search: jest.fn(),
  listWorkspaces: jest.fn(),
  workspaceSummaries: jest.fn(),
  workspaceChats: jest.fn(),
  recentRepositories: jest.fn(),
};
type ProcedureName = keyof typeof mockNetwork;

function mockProcedure(name: ProcedureName) {
  const key = (input: unknown, type = 'query') => [['cliSessionsV2', name], { input, type }];
  return {
    queryKey: (input: unknown) => key(input),
    infiniteQueryKey: (input: unknown) => key(input, 'infinite'),
    queryOptions: (input: unknown) => ({
      queryKey: key(input),
      queryFn: () => mockNetwork[name](input),
    }),
    queryFilter: (input: unknown) => ({ queryKey: key(input) }),
    infiniteQueryFilter: (input: unknown) => ({ queryKey: key(input, 'infinite') }),
    pathFilter: () => ({ queryKey: [['cliSessionsV2', name]] }),
  };
}

const mockTrpc = {
  cliSessionsV2: {
    list: mockProcedure('list'),
    search: mockProcedure('search'),
    listWorkspaces: mockProcedure('listWorkspaces'),
    workspaceSummaries: mockProcedure('workspaceSummaries'),
    workspaceChats: mockProcedure('workspaceChats'),
    recentRepositories: mockProcedure('recentRepositories'),
  },
};
const mockSummaryRequest = jest.fn();
const mockRawTrpc = {
  cliSessionsV2: { workspaceSummaries: { query: mockSummaryRequest } },
};
const mockSessionListeners = new Map<UserWebSessionEventName, Set<(data: never) => void>>();
const mockReconnectListeners = new Set<() => void>();
const mockConnection = {
  onSessionEvent<T extends UserWebSessionEventName>(
    name: T,
    listener: (data: UserWebSessionEventData<T>) => void
  ) {
    const listeners = mockSessionListeners.get(name) ?? new Set();
    const callback = listener as (data: never) => void;
    listeners.add(callback);
    mockSessionListeners.set(name, listeners);
    return () => listeners.delete(callback);
  },
  onReconnect(listener: () => void) {
    mockReconnectListeners.add(listener);
    return () => mockReconnectListeners.delete(listener);
  },
};

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockTrpc,
  useRawTRPCClient: () => mockRawTrpc,
}));
jest.mock('../CloudAgentProvider', () => ({ useUserWebConnection: () => mockConnection }));

function scope(organizationId: string | null = ORGANIZATION, gitUrl = REPOSITORY): Options {
  const filters = {
    organizationId,
    createdOnPlatform: ['cloud-agent', 'cloud-agent-web'],
    gitUrl: [gitUrl],
  };
  return {
    organizationId,
    listInput: {
      ...filters,
      updatedSince: TIME,
      limit: 200,
      orderBy: 'activity',
      fetchReviewDecision: true,
      standaloneOnly: true,
    },
    workspaceListInput: { ...filters, limit: 200, search: 'matching chat' },
    searchInput: { ...filters, search_string: 'matching chat' },
    isSearchActive: true,
    workspaces: [],
  };
}

function workspace(
  worktreeId = WORKTREE_A,
  overrides: Partial<WorkspaceSummary> = {}
): WorkspaceSummary {
  const summary = workspaceSummaryFixture({ worktreeId, lastActivityAt: TIME, ...overrides });
  return { ...summary, openChats: summary.openChats.map(chat => ({ ...chat, updatedAt: TIME })) };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'v2',
    sessionId: 'ses_root',
    title: 'Matching chat',
    createdAt: TIME,
    updatedAt: TIME,
    status: 'idle',
    statusUpdatedAt: TIME,
    createdOnPlatform: 'cloud-agent',
    organizationId: ORGANIZATION,
    gitUrl: REPOSITORY,
    gitBranch: 'feature',
    parentSessionId: null,
    worktreeId: WORKTREE_A,
    ...overrides,
  };
}

function loadedSession() {
  return {
    session_id: 'ses_root',
    title: 'Matching chat',
    status: 'idle',
    status_updated_at: TIME,
    updated_at: TIME,
    git_url: REPOSITORY,
    git_branch: 'feature',
    cloud_agent_worktree_id: WORKTREE_A,
  };
}

function workspacePages(workspaces: WorkspaceSummary[]) {
  return {
    pages: [
      {
        workspaces,
        nextCursor: null,
        destinationTotals: { ungrouped: workspaces.length },
        marker: 'workspace-page',
      },
    ],
    pageParams: [null],
  };
}

function chatPages() {
  return {
    pages: [
      {
        chats: [
          {
            sessionId: 'ses_root',
            title: 'Matching chat',
            sessionStatus: 'idle',
            sessionStatusUpdatedAt: TIME,
            updatedAt: TIME,
          },
        ],
        nextCursor: null,
        marker: 'chat-page',
      },
    ],
    pageParams: [null],
  };
}

function emit<T extends UserWebSessionEventName>(name: T, data: UserWebSessionEventData<T>) {
  for (const listener of mockSessionListeners.get(name) ?? []) listener(data as never);
}

function emitStatus(
  form: 'full' | 'short',
  status: string,
  at: string,
  statusUpdatedAt: string | null = at
) {
  const common = {
    source: 'v2' as const,
    previousStatus: 'idle',
    status,
    statusUpdatedAt,
    changedAt: at,
  };
  emit(
    'session.status.updated',
    form === 'full'
      ? { ...common, session: session({ status, statusUpdatedAt, updatedAt: at }) }
      : { ...common, sessionId: 'ses_root', updatedAt: at }
  );
}

function installDom() {
  const { parseHTML } = createRequire(__filename)('linkedom') as {
    parseHTML: (html: string) => { window: typeof globalThis };
  };
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    React,
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return {
    container: window.document.getElementById('root') as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('useSidebarLiveUpdates', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let stopObservers: (() => void)[];

  function Probe({ options }: { options: Options }) {
    useSidebarLiveUpdates(options);
    return null;
  }

  async function render(options: Options) {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { options })
        )
      )
    );
  }

  async function advance(milliseconds: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(milliseconds);
    });
  }

  function observe(name: ProcedureName, input: unknown, data: unknown, infinite = false) {
    const procedure = mockTrpc.cliSessionsV2[name];
    const queryKey = infinite ? procedure.infiniteQueryKey(input) : procedure.queryKey(input);
    queryClient.setQueryData(queryKey, data);
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => mockNetwork[name](input),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    stopObservers.push(() => {
      unsubscribe();
      observer.destroy();
    });
    return queryKey;
  }

  beforeAll(() => {
    dom = installDom();
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse(TIME));
    for (const request of Object.values(mockNetwork)) request.mockReset();
    mockSummaryRequest
      .mockReset()
      .mockImplementation(input => mockNetwork.workspaceSummaries(input));
    mockSessionListeners.clear();
    mockReconnectListeners.clear();
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    stopObservers = [];
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    root = createRoot(dom.container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      stopObservers.forEach(stop => stop());
      await queryClient.cancelQueries();
      queryClient.clear();
      await jest.runOnlyPendingTimersAsync();
    });
    jest.useRealTimers();
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve));
    });
  });
  afterAll(async () => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    dom.cleanup();
  });

  it('refreshes workspace cache after 300ms when StrictMode replays effect setup and cleanup', async () => {
    const options = scope();
    const first = workspace();
    options.workspaces = [first];
    const workspaceKey = observe(
      'listWorkspaces',
      options.workspaceListInput,
      workspacePages([first]),
      true
    );
    mockNetwork.workspaceSummaries.mockResolvedValue({
      workspaces: [{ ...first, name: 'StrictMode refreshed workspace' }],
    });
    const lifecycle: string[] = [];
    function StrictModeProbe() {
      useSidebarLiveUpdates(options);
      useEffect(() => {
        lifecycle.push('setup');
        return () => {
          lifecycle.push('cleanup');
        };
      }, []);
      return null;
    }
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(StrictModeProbe)
          )
        )
      );
    });
    expect(lifecycle).toEqual(['setup', 'cleanup', 'setup']);
    await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_A }));
    await advance(299);
    expect(mockNetwork.workspaceSummaries).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(workspaceKey)).toMatchObject({
      pages: [{ workspaces: [{ name: 'Workspace' }] }],
    });
    await advance(1);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(workspaceKey)).toMatchObject({
      pages: [{ workspaces: [{ name: 'StrictMode refreshed workspace' }] }],
    });
    expect(mockNetwork.listWorkspaces).not.toHaveBeenCalled();
  });

  it('coalesces IDs for 300ms, sends current filters, and does not refetch broad lists for known status changes', async () => {
    const options = scope();
    const first = workspace();
    const second = workspace(WORKTREE_B);
    options.workspaces = [first, second];
    const listKey = observe('list', options.listInput, { cliSessions: [loadedSession()] });
    observe('search', options.searchInput, { results: [loadedSession()] });
    observe('recentRepositories', { organizationId: ORGANIZATION }, { repositories: [REPOSITORY] });
    const workspaceKey = observe(
      'listWorkspaces',
      options.workspaceListInput,
      workspacePages([first, second]),
      true
    );
    const lookupInput = {
      organizationId: ORGANIZATION,
      worktreeIds: [WORKTREE_A],
      includeAncestors: true,
    };
    const lookupKey = mockTrpc.cliSessionsV2.workspaceSummaries.queryKey(lookupInput);
    queryClient.setQueryData(lookupKey, { workspaces: [first] });
    mockNetwork.workspaceSummaries.mockResolvedValue({
      workspaces: [
        { ...first, name: 'Updated first' },
        { ...second, name: 'Updated second' },
      ],
    });
    await render(options);
    await act(async () => {
      emitStatus('full', 'busy', NEWER);
      emit('workspace.updated', { worktreeId: WORKTREE_A });
      emit('workspace.updated', { worktreeId: WORKTREE_A });
      emit('workspace.updated', { worktreeId: WORKTREE_B });
    });
    expect(queryClient.getQueryData(listKey)).toMatchObject({ cliSessions: [{ status: 'busy' }] });
    await advance(299);
    expect(mockNetwork.workspaceSummaries).not.toHaveBeenCalled();
    await advance(1);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      worktreeIds: [WORKTREE_A, WORKTREE_B],
      createdOnPlatform: ['cloud-agent', 'cloud-agent-web'],
      gitUrl: [REPOSITORY],
      search: 'matching chat',
    });
    expect(queryClient.getQueryData(workspaceKey)).toMatchObject({
      pages: [
        {
          marker: 'workspace-page',
          workspaces: [{ name: 'Updated first' }, { name: 'Updated second' }],
        },
      ],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(lookupKey)).toMatchObject({
      workspaces: [{ name: 'Updated first' }],
    });
    for (const name of ['list', 'search', 'recentRepositories', 'listWorkspaces'] as const)
      expect(mockNetwork[name]).not.toHaveBeenCalled();
  });

  it('aborts stalled summary requests and processes later workspace events', async () => {
    const options = scope();
    const first = workspace();
    options.workspaces = [first];
    const key = observe(
      'listWorkspaces',
      options.workspaceListInput,
      workspacePages([first]),
      true
    );
    const signals: AbortSignal[] = [];
    mockSummaryRequest.mockImplementation((_input, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await render(options);
    await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_A }));
    await advance(300 + WORKSPACE_REFRESH_TIMEOUT_MS * 2 + 1_000);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    mockSummaryRequest.mockResolvedValue({
      workspaces: [{ ...first, name: 'Recovered workspace' }],
    });
    await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_A }));
    await advance(300);
    expect(queryClient.getQueryData(key)).toMatchObject({
      pages: [{ workspaces: [{ name: 'Recovered workspace' }] }],
    });
  });

  it('removes an adopted standalone chat immediately without refetching the standalone list', async () => {
    const options = scope();
    const listKey = observe('list', options.listInput, {
      cliSessions: [{ ...loadedSession(), cloud_agent_worktree_id: null }],
    });
    const searchKey = observe('search', options.searchInput, {
      results: [{ ...loadedSession(), cloud_agent_worktree_id: null }],
    });
    mockNetwork.workspaceSummaries.mockResolvedValue({ workspaces: [workspace()] });
    mockNetwork.search.mockResolvedValue({ results: [loadedSession()] });
    await render(options);
    await act(async () =>
      emit('session.updated', {
        source: 'v2',
        session: session({ updatedAt: NEWER }),
        changedAt: NEWER,
      })
    );
    expect(queryClient.getQueryData(listKey)).toEqual({ cliSessions: [] });
    expect(queryClient.getQueryData(searchKey)).toMatchObject({
      results: [{ cloud_agent_worktree_id: WORKTREE_A }],
    });
    expect(mockNetwork.list).not.toHaveBeenCalled();
  });

  it('keeps a standalone chat when an older adoption event arrives', async () => {
    const options = scope();
    const cached = {
      ...loadedSession(),
      cloud_agent_worktree_id: null,
      status_updated_at: NEWER,
      updated_at: NEWER,
    };
    const listKey = observe('list', options.listInput, { cliSessions: [cached] });
    mockNetwork.search.mockResolvedValue({ results: [] });
    await render(options);
    await act(async () =>
      emit('session.updated', { source: 'v2', session: session(), changedAt: TIME })
    );
    expect(queryClient.getQueryData(listKey)).toEqual({ cliSessions: [cached] });
  });

  it('refreshes selected workspace tabs when sidebar filters exclude the workspace', async () => {
    const options = scope();
    const first = workspace();
    const second = workspace(WORKTREE_B);
    options.workspaces = [second];
    const workspaceKey = observe(
      'listWorkspaces',
      options.workspaceListInput,
      workspacePages([second]),
      true
    );
    const lookupKey = observe(
      'workspaceSummaries',
      { organizationId: ORGANIZATION, worktreeIds: [WORKTREE_A], includeAncestors: true },
      { workspaces: [first] }
    );
    const refreshed = { ...first, openChats: [], closedChats: first.openChats };
    mockNetwork.workspaceSummaries.mockImplementation(input =>
      Promise.resolve({ workspaces: input.search ? [] : [refreshed] })
    );
    await render(options);
    await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_A }));
    await advance(300);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      worktreeIds: [WORKTREE_A],
    });
    expect(queryClient.getQueryData(lookupKey)).toMatchObject({ workspaces: [refreshed] });
    expect(queryClient.getQueryData(workspaceKey)).toEqual(workspacePages([second]));
    expect(mockNetwork.listWorkspaces).not.toHaveBeenCalled();
  });

  it('loads a new stacked layer after another window creates it', async () => {
    const options = scope();
    const first = workspace();
    const layer = workspace(WORKTREE_B, {
      parentWorktreeId: WORKTREE_A,
      stackRootId: WORKTREE_A,
      stackDepth: 1,
    });
    options.workspaces = [first];
    const workspaceKey = observe(
      'listWorkspaces',
      options.workspaceListInput,
      workspacePages([first]),
      true
    );
    mockNetwork.workspaceSummaries.mockResolvedValue({ workspaces: [layer] });
    mockNetwork.listWorkspaces.mockResolvedValue(workspacePages([first, layer]));
    await render(options);
    await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_B }));
    await advance(300);
    expect(mockNetwork.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(workspaceKey)).toEqual(workspacePages([first, layer]));
  });

  it.each(['created', 'updated', 'full-status', 'short-status', 'deleted'] as const)(
    'refreshes workspaces from legacy %s events without workspace.updated',
    async event => {
      const options = scope();
      const first = workspace();
      options.workspaces = [first];
      const workspaceKey = observe(
        'listWorkspaces',
        options.workspaceListInput,
        workspacePages([first]),
        true
      );
      mockNetwork.workspaceSummaries.mockResolvedValue({
        workspaces: [{ ...first, name: 'Legacy event refresh' }],
      });
      mockNetwork.recentRepositories.mockResolvedValue({ repositories: [REPOSITORY] });
      await render(options);
      await act(async () => {
        if (event === 'created' || event === 'updated')
          emit(`session.${event}`, { source: 'v2', session: session(), changedAt: NEWER });
        else if (event === 'deleted')
          emit('session.deleted', {
            source: 'v2',
            sessionId: 'ses_root',
            parentSessionId: null,
            organizationId: ORGANIZATION,
            gitUrl: REPOSITORY,
            gitBranch: 'feature',
            createdOnPlatform: 'cloud-agent',
            deletedAt: NEWER,
          });
        else emitStatus(event === 'full-status' ? 'full' : 'short', 'busy', NEWER);
      });
      await advance(300);
      expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(workspaceKey)).toMatchObject({
        pages: [{ workspaces: [{ name: 'Legacy event refresh' }] }],
      });
      expect(mockNetwork.listWorkspaces).not.toHaveBeenCalled();
    }
  );

  it.each(['full', 'short'] as const)(
    'does not regress list, search, or chat caches when a newer %s status precedes older events',
    async form => {
      const options = scope();
      const listKey = observe('list', options.listInput, {
        cliSessions: [loadedSession()],
        marker: 'list',
      });
      const searchKey = observe('search', options.searchInput, {
        results: [loadedSession()],
        marker: 'search',
      });
      const chatsKey = observe(
        'workspaceChats',
        { organizationId: ORGANIZATION, worktreeId: WORKTREE_A },
        chatPages(),
        true
      );
      const foreignChatsKey = observe(
        'workspaceChats',
        { organizationId: OTHER_ORGANIZATION, worktreeId: WORKTREE_A },
        chatPages(),
        true
      );
      await render(options);
      await act(async () => {
        emitStatus(form, 'question', NEWER);
        emitStatus(form === 'full' ? 'short' : 'full', 'busy', OLDER);
        emitStatus('short', 'idle', TIME, null);
      });
      expect(queryClient.getQueryData(listKey)).toMatchObject({
        marker: 'list',
        cliSessions: [{ status: 'question', status_updated_at: NEWER, updated_at: NEWER }],
      });
      expect(queryClient.getQueryData(searchKey)).toMatchObject({
        marker: 'search',
        results: [{ status: 'question', status_updated_at: NEWER, updated_at: NEWER }],
      });
      expect(queryClient.getQueryData(chatsKey)).toMatchObject({
        pages: [
          {
            marker: 'chat-page',
            chats: [{ sessionStatus: 'question', sessionStatusUpdatedAt: NEWER, updatedAt: NEWER }],
          },
        ],
        pageParams: [null],
      });
      expect(queryClient.getQueryData(foreignChatsKey)).toMatchObject({
        pages: [{ chats: [{ sessionStatus: 'idle' }] }],
      });
      for (const request of Object.values(mockNetwork)) expect(request).not.toHaveBeenCalled();
    }
  );

  it('reconciles active summary lookups and chat pages after reconnect without refetching another organization', async () => {
    const options = scope();
    const first = workspace();
    const lookupInput = {
      organizationId: ORGANIZATION,
      worktreeIds: [WORKTREE_A],
      includeAncestors: true,
    };
    const lookupKey = observe('workspaceSummaries', lookupInput, { workspaces: [first] });
    const chatsInput = { organizationId: ORGANIZATION, worktreeId: WORKTREE_A };
    const chatsKey = observe('workspaceChats', chatsInput, chatPages(), true);
    const foreignKey = observe(
      'workspaceSummaries',
      { ...lookupInput, organizationId: OTHER_ORGANIZATION },
      { workspaces: [first] }
    );
    observe(
      'workspaceChats',
      { ...chatsInput, organizationId: OTHER_ORGANIZATION },
      chatPages(),
      true
    );
    const inactiveKey = mockTrpc.cliSessionsV2.workspaceSummaries.queryKey({
      organizationId: ORGANIZATION,
      worktreeIds: [WORKTREE_B],
    });
    queryClient.setQueryData(inactiveKey, { workspaces: [workspace(WORKTREE_B)] });
    mockNetwork.workspaceSummaries.mockResolvedValue({
      workspaces: [{ ...first, name: 'Reconnected workspace' }],
    });
    const chats = chatPages();
    chats.pages[0].chats[0].title = 'Reconnected chat';
    mockNetwork.workspaceChats.mockResolvedValue(chats);
    await render(options);
    await act(async () => {
      for (const listener of mockReconnectListeners) listener();
    });
    await advance(0);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
    expect(mockNetwork.workspaceSummaries).toHaveBeenCalledWith(lookupInput);
    expect(mockNetwork.workspaceChats).toHaveBeenCalledTimes(1);
    expect(mockNetwork.workspaceChats).toHaveBeenCalledWith(chatsInput);
    expect(queryClient.getQueryData(lookupKey)).toMatchObject({
      workspaces: [{ name: 'Reconnected workspace' }],
    });
    expect(queryClient.getQueryData(chatsKey)).toMatchObject({
      pages: [{ chats: [{ title: 'Reconnected chat' }] }],
    });
    expect(queryClient.getQueryData(foreignKey)).toMatchObject({
      workspaces: [{ name: 'Workspace' }],
    });
    expect(queryClient.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
  });

  it.each(['background', 'offline'] as const)(
    'pauses polling while %s and resumes an overdue refresh when available',
    async pause => {
      const options = scope();
      const running = workspace(WORKTREE_A, { sessionStatus: 'busy' });
      options.workspaces = [running];
      queryClient.setQueryData(
        mockTrpc.cliSessionsV2.listWorkspaces.infiniteQueryKey(options.workspaceListInput),
        workspacePages([running])
      );
      mockNetwork.workspaceSummaries.mockResolvedValue({
        workspaces: [{ ...running, name: 'Polled workspace' }],
      });
      await render(options);
      await advance(1_000);
      const manager = pause === 'background' ? focusManager : onlineManager;
      await act(async () => {
        if ('setFocused' in manager) manager.setFocused(false);
        else manager.setOnline(false);
      });
      await advance(60_000);
      expect(mockNetwork.workspaceSummaries).not.toHaveBeenCalled();
      await act(async () => {
        if ('setFocused' in manager) manager.setFocused(true);
        else manager.setOnline(true);
      });
      await advance(299);
      expect(mockNetwork.workspaceSummaries).not.toHaveBeenCalled();
      await advance(1);
      expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
      expect(
        queryClient.getQueryData(
          mockTrpc.cliSessionsV2.listWorkspaces.infiniteQueryKey(options.workspaceListInput)
        )
      ).toMatchObject({ pages: [{ workspaces: [{ name: 'Polled workspace' }] }] });
    }
  );

  it.each(['organization', 'repository'] as const)(
    'drops an old in-flight result after the %s scope changes',
    async changedScope => {
      const previous = scope();
      const next =
        changedScope === 'organization'
          ? scope(OTHER_ORGANIZATION)
          : scope(ORGANIZATION, 'https://github.com/example/other.git');
      const first = workspace();
      const second = workspace(WORKTREE_B);
      previous.workspaces = [first];
      next.workspaces = [second];
      const previousKey = mockTrpc.cliSessionsV2.listWorkspaces.infiniteQueryKey(
        previous.workspaceListInput
      );
      const nextKey = mockTrpc.cliSessionsV2.listWorkspaces.infiniteQueryKey(
        next.workspaceListInput
      );
      queryClient.setQueryData(previousKey, workspacePages([first]));
      queryClient.setQueryData(nextKey, workspacePages([second]));
      let finish: (result: { workspaces: WorkspaceSummary[] }) => void = () => undefined;
      mockNetwork.workspaceSummaries
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finish = resolve;
            })
        )
        .mockResolvedValue({ workspaces: [{ ...second, name: 'Current scope update' }] });
      await render(previous);
      await act(async () => emit('workspace.updated', { worktreeId: WORKTREE_A }));
      await advance(300);
      expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(1);
      await render(next);
      await act(async () => {
        emit('workspace.updated', { worktreeId: WORKTREE_B });
        finish({ workspaces: [{ ...first, name: 'Stale scope update' }] });
      });
      expect(queryClient.getQueryData(previousKey)).toMatchObject({
        pages: [{ workspaces: [{ name: 'Workspace' }] }],
      });
      expect(queryClient.getQueryData(nextKey)).toMatchObject({
        pages: [{ workspaces: [{ name: 'Workspace' }] }],
      });
      await advance(300);
      expect(mockNetwork.workspaceSummaries).toHaveBeenCalledTimes(2);
      expect(mockNetwork.workspaceSummaries).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationId: next.organizationId,
          gitUrl: next.workspaceListInput.gitUrl,
          worktreeIds: [WORKTREE_B],
        })
      );
      expect(queryClient.getQueryData(nextKey)).toMatchObject({
        pages: [{ workspaces: [{ name: 'Current scope update' }] }],
      });
      expect(queryClient.getQueryData(previousKey)).toMatchObject({
        pages: [{ workspaces: [{ name: 'Workspace' }] }],
      });
    }
  );
});
