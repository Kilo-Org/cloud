import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider, createStore } from 'jotai';
import { dbSessionsAtom } from '../store/db-session-atoms';
import { sidebarListInput, sidebarWorkspaceListInput } from './sidebar-queries';
import { workspaceSummaryFixture, WORKSPACE_FIXTURE_TIME } from './workspace-summary-test-fixtures';
import { useSidebarSessions } from './useSidebarSessions';

const mockLiveUpdates = jest.fn();
jest.mock('./useSidebarLiveUpdates', () => ({
  useSidebarLiveUpdates: (input: unknown) => mockLiveUpdates(input),
}));

function mockProcedure(name: string) {
  const queryKey = (input?: unknown) => [['cliSessionsV2', name], { input, type: 'query' }];
  return {
    queryOptions: (input: unknown) => ({
      queryKey: queryKey(input),
      queryFn: async () => {
        throw new Error(`Unexpected request: ${name}`);
      },
    }),
    mutationOptions: () => ({ mutationFn: jest.fn() }),
    queryKey,
    queryFilter: (input: unknown) => ({ queryKey: queryKey(input) }),
    pathFilter: () => ({ queryKey: [['cliSessionsV2', name]] }),
    infiniteQueryOptions: (input: unknown, options: object) => ({
      queryKey: queryKey(input),
      initialPageParam: null,
      queryFn: async () => {
        throw new Error(`Unexpected request: ${name}`);
      },
      ...options,
    }),
    infiniteQueryFilter: (input: unknown) => ({ queryKey: queryKey(input) }),
  };
}

const mockTrpc = {
  cliSessionsV2: {
    list: mockProcedure('list'),
    search: mockProcedure('search'),
    listWorkspaces: mockProcedure('listWorkspaces'),
    workspaceSummaries: mockProcedure('workspaceSummaries'),
    refreshAssociatedPullRequest: mockProcedure('refreshAssociatedPullRequest'),
  },
};
jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

it('reads hydrated summaries and standalone sessions directly from React Query, not Jotai', () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const store = createStore();
  const summary = workspaceSummaryFixture();
  const filters = { organizationId: null, createdOnPlatform: undefined, gitUrl: undefined };
  const listInput = sidebarListInput({ ...filters, updatedSince: WORKSPACE_FIXTURE_TIME });
  const workspaceInput = sidebarWorkspaceListInput(filters);
  client.setQueryData(mockTrpc.cliSessionsV2.list.queryKey(listInput), { cliSessions: [] });
  client.setQueryData(mockTrpc.cliSessionsV2.listWorkspaces.queryKey(workspaceInput), {
    pages: [
      {
        workspaces: [summary],
        workspaceOrder: 'activity',
        truncated: false,
        destinationTotals: { ungrouped: 1 },
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
  let result: ReturnType<typeof useSidebarSessions> | undefined;
  function Probe() {
    result = useSidebarSessions({ updatedSince: WORKSPACE_FIXTURE_TIME });
    return null;
  }
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Provider, { store }, createElement(Probe))
    )
  );
  expect(result?.sessions).toEqual([]);
  expect(result?.workspaceRows[0]).toEqual(summary);
  expect(result?.cachedSessions.map(chat => chat.sessionId)).toEqual(['ses_root']);
  expect(result?.workspaceOrder).toBe('activity');
  expect(store.get(dbSessionsAtom)).toEqual([]);
  expect(mockLiveUpdates).toHaveBeenCalledWith(
    expect.objectContaining({
      listInput: expect.objectContaining({ standaloneOnly: true }),
      workspaces: [summary],
    })
  );
  client.clear();
});
