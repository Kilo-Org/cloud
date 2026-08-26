import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as React from 'react';
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
  type Mutation,
  type MutationFilters,
  type MutationObserverOptions,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import type * as ReactQuery from '@tanstack/react-query';
import { createStore, type Atom, type WritableAtom } from 'jotai';
import type * as Jotai from 'jotai';
import type { toast as Toast } from 'sonner';
import { AlertDialog, AlertDialogAction } from '@/components/ui/alert-dialog';
import type { ChatSidebar as ChatSidebarComponent } from './ChatSidebar';
import type { CloudSidebarLayout as CloudSidebarLayoutComponent } from './CloudSidebarLayout';
import type * as DbSessionAtoms from './store/db-session-atoms';

jest.mock('react', () => ({
  ...jest.requireActual<typeof React>('react'),
  useState: mockUseState,
  useMemo: mockUseMemo,
  useCallback: <T>(callback: T, dependencies: React.DependencyList) =>
    mockUseMemo(() => callback, dependencies),
  useRef: <T>(initial: T) => mockUseMemo(() => ({ current: initial }), []),
  useEffect: mockUseEffect,
}));

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual<typeof ReactQuery>('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  useMutationState: <T>(options: { filters: MutationFilters; select: (mutation: Mutation) => T }) =>
    mockQueryClient.getMutationCache().findAll(options.filters).map(options.select),
}));

jest.mock('jotai', () => ({
  ...jest.requireActual<typeof Jotai>('jotai'),
  useAtomValue: <T>(target: Atom<T>) => mockStore.get(target),
  useSetAtom: <Value, Args extends unknown[], Result>(target: WritableAtom<Value, Args, Result>) =>
    mockUseMemo(
      () =>
        (...args: Args) =>
          mockStore.set(target, ...args),
      [target]
    ),
}));

jest.mock('./store/db-session-atoms', () => {
  const { atom } = jest.requireActual<typeof Jotai>('jotai');
  return {
    ...jest.requireActual<typeof DbSessionAtoms>('./store/db-session-atoms'),
    deleteSessionFromStoreAtom: atom(null, (_get, _set, sessionId: string) =>
      mockDeleteFromStore(sessionId)
    ),
  };
});

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('./CloudAgentProvider', () => ({ useUserWebConnection: () => null }));
jest.mock('./ChatSidebar', () => ({ ChatSidebar: () => null }));
jest.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: <T>(_key: string, initial: T) => mockUseState(initial),
}));
jest.mock('sonner', () => ({ toast: Object.assign(jest.fn(), { error: jest.fn() }) }));

type SidebarProps = React.ComponentProps<typeof ChatSidebar>;
type ApiSession = Parameters<typeof apiSessionToDbSession>[0];
type DeleteInput = { session_id: string };
type ServerData = {
  list: { cliSessions: ApiSession[] };
  search: { results: ApiSession[] };
  active: { sessions: NonNullable<SidebarProps['activeSessions']> };
  repositories: { repositories: { gitUrl: string }[] };
};
type HookState<T> = { value: T; set: React.Dispatch<React.SetStateAction<T>> };

let CloudSidebarLayout: typeof CloudSidebarLayoutComponent;
let ChatSidebar: typeof ChatSidebarComponent;
let apiSessionToDbSession: typeof DbSessionAtoms.apiSessionToDbSession;
let dbSessionsAtom: typeof DbSessionAtoms.dbSessionsAtom;
let toast: typeof Toast;
let mockQueryClient: QueryClient;
let mockStore: ReturnType<typeof createStore>;
let mockServer: ServerData;
let mockTrpc: ReturnType<typeof createMockTrpc>;
let mockRouter: { replace: ReturnType<typeof jest.fn> };
let mockSearchParams: URLSearchParams;
let mockOrganizationId: string | undefined;
let mockHookStates: unknown[];
let mockHookIndex: number;
let mockNeedsRender: boolean;
let mockEffects: (() => void)[];
let mockCleanups: (() => void)[];
let mockRequests: Map<string, ReturnType<typeof deferred<void>>>;
let previousReact: PropertyDescriptor | undefined;
const mockDeleteSession = jest.fn<(input: DeleteInput) => Promise<void>>();
const mockDeleteFromStore = jest.fn<(sessionId: string) => Promise<void>>();

function mockUseState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const index = mockHookIndex++;
  if (!(index in mockHookStates)) {
    const state: HookState<T> = {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
      set: update => {
        const next =
          typeof update === 'function' ? (update as (value: T) => T)(state.value) : update;
        if (!Object.is(next, state.value)) {
          state.value = next;
          mockNeedsRender = true;
        }
      },
    };
    mockHookStates[index] = state;
  }
  const state = mockHookStates[index] as HookState<T>;
  return [state.value, state.set];
}

function mockUseMemo<T>(factory: () => T, dependencies?: React.DependencyList): T {
  const [memo] = mockUseState(() => ({ value: factory(), dependencies }));
  if (
    !dependencies ||
    !memo.dependencies ||
    dependencies.length !== memo.dependencies.length ||
    dependencies.some((value, index) => !Object.is(value, memo.dependencies?.[index]))
  ) {
    memo.value = factory();
    memo.dependencies = dependencies;
  }
  return memo.value;
}

function mockUseEffect(effect: React.EffectCallback, dependencies?: React.DependencyList) {
  const [state] = mockUseState(() => {
    const state: { cleanup?: () => void } = {};
    mockCleanups.push(() => state.cleanup?.());
    return state;
  });
  mockUseMemo(() => {
    mockEffects.push(() => {
      state.cleanup?.();
      state.cleanup = effect() ?? undefined;
    });
  }, dependencies);
}

function mockUseQuery<T>(options: QueryObserverOptions<T>) {
  const [observer] = mockUseState(() => {
    const observer = new QueryObserver(mockQueryClient, options);
    mockCleanups.push(observer.subscribe(() => (mockNeedsRender = true)));
    return observer;
  });
  observer.setOptions(options);
  return observer.getCurrentResult();
}

function mockUseMutation<TData, TVariables>(
  options: MutationObserverOptions<TData, Error, TVariables>
) {
  const [observer] = mockUseState(() => new MutationObserver(mockQueryClient, options));
  observer.setOptions(options);
  const result = observer.getCurrentResult();
  return {
    ...result,
    mutateAsync: result.mutate,
    mutate: (...args: Parameters<typeof observer.mutate>) => {
      void observer.mutate(...args).catch(() => {});
    },
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function queryEndpoint<T>(path: string, getData: () => T) {
  const queryKey = (input?: unknown) => [path, input ?? null] as const;
  const fetch = jest.fn(async () => getData());
  return {
    queryKey,
    pathFilter: () => ({ queryKey: [path] }),
    queryOptions: (input?: unknown) => ({
      queryKey: queryKey(input),
      queryFn: fetch,
      initialData: getData,
    }),
    fetch,
  };
}

function createMockTrpc() {
  return {
    cliSessionsV2: {
      list: queryEndpoint('cliSessionsV2.list', () => mockServer.list),
      search: queryEndpoint('cliSessionsV2.search', () => mockServer.search),
      recentRepositories: queryEndpoint(
        'cliSessionsV2.recentRepositories',
        () => mockServer.repositories
      ),
      delete: {
        mutationKey: () => ['cliSessionsV2.delete'],
        mutationOptions: (options: MutationObserverOptions<void, Error, DeleteInput>) => ({
          ...options,
          mutationKey: ['cliSessionsV2.delete'],
          mutationFn: mockDeleteSession,
        }),
      },
      rename: {
        mutationOptions: () => ({
          mutationKey: ['cliSessionsV2.rename'],
          mutationFn: async () => undefined,
        }),
      },
    },
    activeSessions: { list: queryEndpoint('activeSessions.list', () => mockServer.active) },
  };
}

function makeSession(sessionId: string): ApiSession {
  return {
    session_id: sessionId,
    title: sessionId,
    cloud_agent_session_id: null,
    created_on_platform: 'cloud-agent',
    organization_id: null,
    git_url: null,
    git_branch: null,
    parent_session_id: null,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    version: 2,
    status: 'busy',
    status_updated_at: null,
  };
}

function removeServerSession(sessionId: string) {
  mockServer.list = {
    cliSessions: mockServer.list.cliSessions.filter(session => session.session_id !== sessionId),
  };
  mockServer.search = {
    results: mockServer.search.results.filter(session => session.session_id !== sessionId),
  };
  mockServer.active = {
    sessions: mockServer.active.sessions.filter(session => session.id !== sessionId),
  };
}

function propsFor<T>(node: React.ReactNode, component: React.ElementType): T[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return [];
    return [
      ...(child.type === component ? [child.props as T] : []),
      ...propsFor<T>(child.props.children, component),
    ];
  });
}

function renderLayout() {
  let tree: React.ReactNode;
  let renders = 0;
  do {
    mockNeedsRender = false;
    mockHookIndex = 0;
    tree = CloudSidebarLayout({ organizationId: mockOrganizationId, children: null });
    mockEffects.splice(0).forEach(effect => effect());
    if (++renders > 10) throw new Error('Sidebar hook state did not settle');
  } while (mockNeedsRender);

  const sidebars = propsFor<SidebarProps>(tree, ChatSidebar);
  const sidebar = sidebars.find(props => !props.isInSheet);
  const [dialog] = propsFor<React.ComponentProps<typeof AlertDialog>>(tree, AlertDialog);
  const [action] = propsFor<React.ComponentProps<typeof AlertDialogAction>>(
    tree,
    AlertDialogAction
  );
  if (!sidebar || !dialog || !action) throw new Error('Sidebar deletion controls are missing');
  return { sidebars, sidebar, dialog, action };
}

function confirmDeletion(sessionId: string) {
  const request = deferred<void>();
  mockRequests.set(sessionId, request);
  renderLayout().sidebar.onDeleteSession?.(sessionId);
  const confirmation = renderLayout();
  expect(confirmation.dialog.open).toBe(true);
  expect(confirmation.action.disabled).not.toBe(true);
  if (!confirmation.action.onClick) throw new Error('Delete action has no handler');
  confirmation.action.onClick({} as React.MouseEvent<HTMLButtonElement>);
  return request;
}

function expectVisibleSessions(stored: string[], active: string[] = stored) {
  const { sidebars } = renderLayout();
  expect(sidebars).toHaveLength(2);
  for (const sidebar of sidebars) {
    expect(sidebar.sessions.map(session => session.sessionId)).toEqual(stored);
    expect(sidebar.activeSessions?.map(session => session.id)).toEqual(active);
  }
}

async function flushMutations() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

beforeAll(async () => {
  ({ CloudSidebarLayout } = await import('./CloudSidebarLayout'));
  ({ ChatSidebar } = await import('./ChatSidebar'));
  ({ apiSessionToDbSession, dbSessionsAtom } = await import('./store/db-session-atoms'));
  ({ toast } = await import('sonner'));
});

beforeEach(() => {
  previousReact = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockHookStates = [];
  mockHookIndex = 0;
  mockNeedsRender = false;
  mockEffects = [];
  mockCleanups = [];
  mockOrganizationId = undefined;
  mockSearchParams = new URLSearchParams({ sessionId: 'ses_a' });
  mockRouter = { replace: jest.fn() };
  mockQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const sessions = ['ses_a', 'ses_b', 'ses_c'].map(makeSession);
  mockServer = {
    list: { cliSessions: sessions },
    search: { results: sessions },
    active: {
      sessions: sessions.map(session => ({
        id: session.session_id,
        title: session.title ?? '',
        status: 'busy',
        connectionId: 'connection',
      })),
    },
    repositories: { repositories: [] },
  };
  mockTrpc = createMockTrpc();
  mockStore = createStore();
  mockStore.set(dbSessionsAtom, sessions.map(apiSessionToDbSession));
  mockCleanups.push(mockStore.sub(dbSessionsAtom, () => (mockNeedsRender = true)));
  mockRequests = new Map();
  mockDeleteSession.mockReset().mockImplementation(({ session_id }) => {
    const request = mockRequests.get(session_id);
    if (!request) throw new Error(`Unexpected deletion: ${session_id}`);
    return request.promise;
  });
  mockDeleteFromStore.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  mockCleanups.reverse().forEach(cleanup => cleanup());
  mockQueryClient.clear();
  jest.restoreAllMocks();
  if (previousReact) Object.defineProperty(globalThis, 'React', previousReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

describe('CloudSidebarLayout optimistic deletion', () => {
  it.each([
    [undefined, '/cloud'],
    ['org_test', '/organizations/org_test/cloud'],
  ])(
    'closes, hides and leaves the active session synchronously for %s',
    async (organizationId, path) => {
      mockOrganizationId = organizationId;
      const request = confirmDeletion('ses_a');

      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
      expect(mockRouter.replace).toHaveBeenCalledWith(path);
      expect(renderLayout().dialog.open).toBe(false);
      expectVisibleSessions(['ses_b', 'ses_c']);
      expect(mockQueryClient.isMutating()).toBe(1);
      expect(mockStore.get(dbSessionsAtom).map(session => session.session_id)).toEqual([
        'ses_a',
        'ses_b',
        'ses_c',
      ]);
      expect(mockDeleteFromStore).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();

      removeServerSession('ses_a');
      request.resolve();
      await flushMutations();
    }
  );

  it('restores a failed inactive deletion without rolling back newer live data or navigating', async () => {
    mockSearchParams.set('sessionId', 'ses_c');
    const request = confirmDeletion('ses_a');
    expectVisibleSessions(['ses_b', 'ses_c']);
    expect(mockRouter.replace).not.toHaveBeenCalled();

    const updated = { ...makeSession('ses_a'), title: 'New live title' };
    const added = makeSession('ses_new');
    mockServer.list = { cliSessions: [updated, makeSession('ses_b'), makeSession('ses_c'), added] };
    mockStore.set(dbSessionsAtom, mockServer.list.cliSessions.map(apiSessionToDbSession));
    mockQueryClient.setQueriesData(mockTrpc.cliSessionsV2.list.pathFilter(), mockServer.list);
    const reconciliation = deferred<ServerData['list']>();
    mockTrpc.cliSessionsV2.list.fetch.mockReturnValueOnce(reconciliation.promise);
    const invalidate = jest.spyOn(mockQueryClient, 'invalidateQueries');

    request.reject(new Error('Deletion failed'));
    await flushMutations();

    expectVisibleSessions(['ses_a', 'ses_b', 'ses_c', 'ses_new'], ['ses_a', 'ses_b', 'ses_c']);
    expect(renderLayout().sidebar.sessions[0].prompt).toBe('New live title');
    expect(renderLayout().dialog.open).toBe(false);
    expect(mockDeleteFromStore).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Failed to delete session. Please try again.');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.list.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.search.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.recentRepositories.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.activeSessions.list.pathFilter());

    reconciliation.resolve(mockServer.list);
    await flushMutations();
  });

  it.each(['success', 'error'] as const)(
    'keeps concurrent deletions independent when the second succeeds before the first returns %s',
    async outcome => {
      const first = confirmDeletion('ses_a');
      const second = confirmDeletion('ses_b');
      expectVisibleSessions(['ses_c']);
      expect(mockQueryClient.isMutating()).toBe(2);

      removeServerSession('ses_b');
      second.resolve();
      await flushMutations();
      expectVisibleSessions(['ses_c']);
      expect(mockQueryClient.isMutating()).toBe(1);
      expect(mockDeleteFromStore).toHaveBeenCalledTimes(1);
      expect(mockDeleteFromStore).toHaveBeenCalledWith('ses_b');

      if (outcome === 'success') {
        removeServerSession('ses_a');
        first.resolve();
      } else {
        first.reject(new Error('First deletion failed'));
      }
      await flushMutations();

      const expected = outcome === 'success' ? ['ses_c'] : ['ses_a', 'ses_c'];
      expectVisibleSessions(expected);
      expect(mockStore.get(dbSessionsAtom).map(session => session.session_id)).toEqual(expected);
      expect(mockQueryClient.isMutating()).toBe(0);
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
      expect(mockRouter.replace).toHaveBeenCalledWith('/cloud');
    }
  );

  it.each(['success', 'error'] as const)(
    'does not let an older deletion %s close a newer confirmation or replace newer navigation',
    async outcome => {
      const first = confirmDeletion('ses_a');
      mockSearchParams.set('sessionId', 'ses_c');
      renderLayout().sidebar.onDeleteSession?.('ses_b');
      expect(renderLayout().dialog.open).toBe(true);

      if (outcome === 'success') {
        removeServerSession('ses_a');
        first.resolve();
      } else {
        first.reject(new Error('Old deletion failed'));
      }
      await flushMutations();

      const view = renderLayout();
      expect(view.dialog.open).toBe(true);
      expect(view.sidebar.currentSessionId).toBe('ses_c');
      expect(view.action.disabled).not.toBe(true);
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
      expect(mockRouter.replace).toHaveBeenCalledWith('/cloud');
      const second = deferred<void>();
      mockRequests.set('ses_b', second);
      view.action.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
      await flushMutations();
      expect(mockDeleteSession.mock.calls.map(([input]) => input)).toEqual([
        { session_id: 'ses_a' },
        { session_id: 'ses_b' },
      ]);
      expect(renderLayout().dialog.open).toBe(false);
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);

      removeServerSession('ses_b');
      second.resolve();
      await flushMutations();
    }
  );

  it('filters pending deletions from search and refreshed live-only rows, but not unrelated mutations', async () => {
    const deletion = confirmDeletion('ses_a');
    const unrelated = deferred<void>();
    const unrelatedMutation = mockQueryClient.getMutationCache().build(mockQueryClient, {
      mutationKey: ['unrelated'],
      mutationFn: () => unrelated.promise,
    });
    const unrelatedCompletion = unrelatedMutation.execute({ session_id: 'ses_b' });

    renderLayout().sidebar.onSearchChange?.('matching');
    expectVisibleSessions(['ses_b', 'ses_c']);
    mockServer.search = { results: [makeSession('ses_b')] };
    mockQueryClient.setQueryData(mockTrpc.activeSessions.list.queryKey(), {
      sessions: [
        ...mockServer.active.sessions,
        { id: 'ses_remote', title: 'Remote', status: 'busy', connectionId: 'remote' },
      ],
    });
    renderLayout().sidebar.onSearchChange?.('different');
    expectVisibleSessions(['ses_b'], ['ses_b', 'ses_c', 'ses_remote']);
    expect(mockQueryClient.isMutating()).toBe(2);

    removeServerSession('ses_a');
    deletion.resolve();
    unrelated.resolve();
    await unrelatedCompletion;
    await flushMutations();
    expectVisibleSessions(['ses_b'], ['ses_b', 'ses_c']);
  });

  it('removes confirmed sessions from Jotai, every list/search cache, active sessions and IndexedDB before awaiting reconciliation', async () => {
    renderLayout();
    const inactiveListKey = mockTrpc.cliSessionsV2.list.queryKey({ createdOnPlatform: 'cli' });
    const inactiveSearchKey = mockTrpc.cliSessionsV2.search.queryKey({ search_string: 'cached' });
    const otherSearchKey = mockTrpc.cliSessionsV2.search.queryKey({
      search_string: 'another',
      gitUrl: 'repo',
    });
    mockQueryClient.setQueryData(inactiveListKey, mockServer.list);
    mockQueryClient.setQueryData(inactiveSearchKey, mockServer.search);
    mockQueryClient.setQueryData(otherSearchKey, mockServer.search);
    mockQueryClient.setQueryData(['unrelated'], mockServer.search);
    const unrelatedData = mockQueryClient.getQueryData(['unrelated']);
    expect(
      mockQueryClient.getQueryCache().find({ queryKey: inactiveSearchKey })?.getObserversCount()
    ).toBe(0);
    renderLayout().sidebar.onSearchChange?.('current');
    renderLayout();

    const persisted = deferred<void>();
    mockDeleteFromStore.mockReturnValueOnce(persisted.promise);
    const reconciliation = deferred<ServerData['search']>();
    mockTrpc.cliSessionsV2.search.fetch.mockReturnValueOnce(reconciliation.promise);
    const invalidate = jest.spyOn(mockQueryClient, 'invalidateQueries');
    const deletion = confirmDeletion('ses_a');
    removeServerSession('ses_a');
    deletion.resolve();
    await flushMutations();

    expect(mockDeleteFromStore).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromStore).toHaveBeenCalledWith('ses_a');
    expect(mockStore.get(dbSessionsAtom).map(session => session.session_id)).toEqual([
      'ses_b',
      'ses_c',
    ]);
    for (const [, data] of mockQueryClient.getQueriesData<ServerData['list']>(
      mockTrpc.cliSessionsV2.list.pathFilter()
    )) {
      expect(data?.cliSessions.map(session => session.session_id)).toEqual(['ses_b', 'ses_c']);
    }
    for (const [, data] of mockQueryClient.getQueriesData<ServerData['search']>(
      mockTrpc.cliSessionsV2.search.pathFilter()
    )) {
      expect(data?.results.map(session => session.session_id)).toEqual(['ses_b', 'ses_c']);
    }
    expect(mockQueryClient.getQueryData(mockTrpc.activeSessions.list.queryKey())).toEqual(
      mockServer.active
    );
    expect(mockQueryClient.getQueryData(['unrelated'])).toBe(unrelatedData);
    expect(invalidate).not.toHaveBeenCalled();
    expect(mockQueryClient.isMutating()).toBe(1);
    expectVisibleSessions(['ses_b', 'ses_c']);

    persisted.resolve();
    await flushMutations();
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.list.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.search.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.cliSessionsV2.recentRepositories.pathFilter());
    expect(invalidate).toHaveBeenCalledWith(mockTrpc.activeSessions.list.pathFilter());
    expect(mockTrpc.cliSessionsV2.search.fetch).toHaveBeenCalledTimes(1);
    expect(mockQueryClient.isMutating()).toBe(1);
    expect(toast).toHaveBeenCalledWith('Session deleted successfully');
    expectVisibleSessions(['ses_b', 'ses_c']);

    reconciliation.resolve(mockServer.search);
    await flushMutations();
    expect(mockQueryClient.isMutating()).toBe(0);
    expectVisibleSessions(['ses_b', 'ses_c']);
    expect(mockQueryClient.getQueryData(inactiveSearchKey)).toEqual(mockServer.search);
    expect(mockQueryClient.getQueryData(otherSearchKey)).toEqual(mockServer.search);
  });
});
