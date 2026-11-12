import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { QueryClient } from '@tanstack/react-query';
import type * as ReactQuery from '@tanstack/react-query';
import { Provider, createStore } from 'jotai';
import type { UserWebSessionEventData } from '@kilocode/cloud-agent-sdk';
import { dbSessionsAtom } from '../store/db-session-atoms';
import { sidebarWorkspaceListInput } from './sidebar-queries';
import { useSidebarSessions, SIDEBAR_RECONCILE_DELAY_MS } from './useSidebarSessions';

const mockListeners = new Map<string, (data: UserWebSessionEventData<'session.created'>) => void>();
let mockReconnect: () => void;
let mockClient: QueryClient;
const mockInvalidate = jest.fn<Promise<void>, [unknown?, unknown?]>(async () => {});
const mockConnection = {
  onSessionEvent: (
    name: string,
    listener: (data: UserWebSessionEventData<'session.created'>) => void
  ) => {
    mockListeners.set(name, listener);
    return () => mockListeners.delete(name);
  },
  onReconnect: (listener: () => void) => {
    mockReconnect = listener;
    return () => {};
  },
};
jest.mock('../CloudAgentProvider', () => ({ useUserWebConnection: () => mockConnection }));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual<typeof ReactQuery>('@tanstack/react-query'),
  useQueryClient: () => mockClient,
  useQuery: () => ({ data: undefined, isLoading: false }),
  useInfiniteQuery: () => ({ data: undefined }),
  useQueries: ({ combine }: { combine: (queries: []) => unknown }) => combine([]),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));

function mockProcedure(name: string) {
  return {
    queryOptions: () => ({}),
    mutationOptions: () => ({}),
    queryKey: () => [name],
    pathFilter: () => ({ queryKey: [name] }),
    infiniteQueryOptions: () => ({}),
    infiniteQueryFilter: (input: unknown) => ({ queryKey: [name, input] }),
  };
}
const mockTrpc = {
  cliSessionsV2: {
    list: mockProcedure('list'),
    search: mockProcedure('search'),
    recentRepositories: mockProcedure('repositories'),
    worktreeDetails: mockProcedure('details'),
    listWorkspaces: mockProcedure('workspaces'),
    refreshAssociatedPullRequest: mockProcedure('pr'),
  },
  cloudAgentSettings: { getWorkspaceOrder: mockProcedure('order') },
};
jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

const timestamp = '2026-11-10T12:00:00.000Z';
const created: UserWebSessionEventData<'session.created'> = {
  source: 'v2',
  changedAt: timestamp,
  session: {
    source: 'v2',
    sessionId: 'ses_created',
    worktreeId: 'worktree_created',
    title: 'New chat',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdOnPlatform: 'cloud-agent-web',
    organizationId: null,
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: timestamp,
  },
};

async function mount(platforms: string[]) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const element = window.document.getElementById('root');
  if (!element) throw new Error('Missing test root');
  const root = createRoot(element);
  const store = createStore();
  function Sidebar({ options }: { options: Parameters<typeof useSidebarSessions>[0] }) {
    useSidebarSessions(options);
    return null;
  }
  async function render(options: Parameters<typeof useSidebarSessions>[0] = {}) {
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Sidebar, {
            options: { organizationId: null, createdOnPlatform: platforms, ...options },
          })
        )
      )
    );
  }
  await render();
  return {
    store,
    rerender: render,
    cleanup() {
      act(() => root.unmount());
      Object.assign(globalThis, previous);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockListeners.clear();
  mockInvalidate.mockClear();
  mockClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  mockClient.invalidateQueries = mockInvalidate;
});
afterEach(() => {
  mockClient.clear();
  jest.useRealTimers();
});

it('patches created/updated rows immediately and coalesces one delayed reconciliation', async () => {
  const sidebar = await mount(['cloud-agent-web']);
  try {
    await act(async () => {
      mockListeners.get('session.created')?.(created);
      mockListeners.get('session.updated')?.({
        ...created,
        session: { ...created.session, title: 'Server title' },
      });
    });
    expect(sidebar.store.get(dbSessionsAtom)).toMatchObject([
      { session_id: 'ses_created', title: 'Server title' },
    ]);
    expect(mockInvalidate).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTimeAsync(SIDEBAR_RECONCILE_DELAY_MS));
    expect(mockInvalidate).toHaveBeenCalledTimes(5);
    for (const call of mockInvalidate.mock.calls) expect(call[1]).toEqual({ cancelRefetch: false });
  } finally {
    sidebar.cleanup();
  }
});

it('reconciles unknown filters immediately and reconnects without waiting for the timer', async () => {
  const sidebar = await mount(['other']);
  try {
    await act(async () => mockListeners.get('session.created')?.(created));
    expect(mockInvalidate).toHaveBeenCalledTimes(5);
    expect(sidebar.store.get(dbSessionsAtom)).toEqual([]);
    act(() => mockReconnect());
    expect(mockInvalidate).toHaveBeenCalledTimes(10);
  } finally {
    sidebar.cleanup();
  }
});

it.each<NonNullable<Parameters<typeof useSidebarSessions>[0]>>([
  { searchQuery: 'Server' },
  { organizationId: 'organization-synthetic' },
  { createdOnPlatform: ['cli'] },
  { gitUrl: 'https://github.com/example/repository' },
])('retains a pending reconciliation with the current filters: %j', async filters => {
  const sidebar = await mount(['cloud-agent-web']);
  try {
    await act(async () => mockListeners.get('session.created')?.(created));
    await act(async () => jest.advanceTimersByTimeAsync(SIDEBAR_RECONCILE_DELAY_MS / 2));
    await sidebar.rerender(filters);
    expect(mockInvalidate).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTimeAsync(SIDEBAR_RECONCILE_DELAY_MS / 2));
    expect(mockInvalidate).toHaveBeenCalledTimes(5);
    expect(mockInvalidate).toHaveBeenCalledWith(
      {
        queryKey: [
          'workspaces',
          sidebarWorkspaceListInput({
            organizationId: null,
            createdOnPlatform: ['cloud-agent-web'],
            gitUrl: undefined,
            ...filters,
            search: filters.searchQuery ?? '',
          }),
        ],
      },
      { cancelRefetch: false }
    );
  } finally {
    sidebar.cleanup();
  }
});

it('cancels a pending reconciliation when the sidebar unmounts', async () => {
  const sidebar = await mount(['cloud-agent-web']);
  try {
    await act(async () => mockListeners.get('session.created')?.(created));
  } finally {
    sidebar.cleanup();
  }
  await act(async () => jest.advanceTimersByTimeAsync(SIDEBAR_RECONCILE_DELAY_MS));
  expect(mockInvalidate).not.toHaveBeenCalled();
});
