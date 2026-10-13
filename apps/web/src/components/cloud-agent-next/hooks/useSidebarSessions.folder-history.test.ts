import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSidebarSessions } from './useSidebarSessions';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const mockListQueryFn = jest.fn(() => Promise.resolve({ cliSessions: [] }));
const mockListOptions = jest.fn((input, options) => ({
  input,
  queryKey: [['cliSessionsV2', 'list'], { input, type: 'query' }],
  queryFn: mockListQueryFn,
  ...options,
}));
const mockFolderQueries = jest.fn();
let mockFolderQueryState = { isLoading: false, isError: false };
let sidebarResult: ReturnType<typeof useSidebarSessions>;

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { queryOptions: mockListOptions, pathFilter: jest.fn() },
      search: { queryOptions: jest.fn(() => ({})), queryKey: jest.fn() },
      worktreeDetails: { queryOptions: jest.fn(() => ({})) },
      refreshAssociatedPullRequest: { mutationOptions: jest.fn(() => ({})) },
    },
  }),
}));
jest.mock('../CloudAgentProvider', () => ({ useUserWebConnection: () => null }));
jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: () => [],
  useSetAtom: () => jest.fn(),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({ isLoading: false }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueries: ({
    queries,
    combine,
  }: {
    queries: unknown[];
    combine: (queries: { isLoading: boolean; isError: boolean }[]) => unknown;
  }) => {
    mockFolderQueries(queries);
    return combine(queries.map(() => mockFolderQueryState));
  },
}));

function Sidebar(props: NonNullable<Parameters<typeof useSidebarSessions>[0]>) {
  sidebarResult = useSidebarSessions(props);
  return null;
}

describe('sidebar folder history queries', () => {
  beforeEach(() => {
    mockListOptions.mockClear();
    mockListQueryFn.mockReset().mockResolvedValue({ cliSessions: [] });
    mockFolderQueries.mockClear();
    mockFolderQueryState = { isLoading: false, isError: false };
  });

  it.each([
    { isLoading: true, isError: false },
    { isLoading: false, isError: true },
  ])('keeps supplemental query state non-fatal: %p', state => {
    mockFolderQueryState = state;
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds: [worktreeId] }));
    expect(sidebarResult.isLoading).toBe(false);
    expect(sidebarResult.sessions).toEqual([]);
    expect(sidebarResult).not.toHaveProperty('isFolderSessionsLoading');
    expect(sidebarResult).not.toHaveProperty('isFolderSessionsError');
  });

  it('fetches one all-time representative per unique workspace with intentional filters', () => {
    renderToStaticMarkup(
      createElement(Sidebar, {
        organizationId,
        createdOnPlatform: ['web'],
        gitUrl: ['https://github.com/kilo/repo'],
        folderWorktreeIds: [worktreeId, worktreeId, 'invalid'],
      })
    );
    expect(mockListOptions).toHaveBeenCalledTimes(2);
    const [recentInput] = mockListOptions.mock.calls[0];
    expect(recentInput.updatedSince).toEqual(expect.any(String));
    const [folderInput, folderOptions] = mockListOptions.mock.calls[1];
    expect(folderInput).toEqual({
      worktreeId,
      limit: 1,
      orderBy: 'updated_at',
      organizationId,
      createdOnPlatform: ['web'],
      gitUrl: ['https://github.com/kilo/repo'],
      fetchReviewDecision: true,
    });
    expect(folderOptions.enabled).toBe(true);
  });

  it('disables supplemental folder contents during search', () => {
    renderToStaticMarkup(
      createElement(Sidebar, { searchQuery: 'matching title', folderWorktreeIds: [worktreeId] })
    );
    expect(mockListOptions.mock.calls[1][1].enabled).toBe(false);
  });

  it('queries every filed workspace beyond the recent-list cap', () => {
    const folderWorktreeIds = Array.from(
      { length: 250 },
      (_, i) => `worktree_11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`
    );
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds }));
    expect(mockListOptions).toHaveBeenCalledTimes(251);
    expect(mockListOptions.mock.calls.slice(1).map(([input]) => input.worktreeId)).toEqual(
      folderWorktreeIds
    );
  });

  it('bounds concurrent requests and continues after a failure without dropping workspaces', async () => {
    const folderWorktreeIds = Array.from(
      { length: 250 },
      (_, i) => `worktree_11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`
    );
    let active = 0;
    let maxActive = 0;
    mockListQueryFn.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return { cliSessions: [] };
    });
    mockListQueryFn.mockRejectedValueOnce(new Error('Unavailable workspace'));
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds }));
    const queries: { queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }[] =
      mockFolderQueries.mock.calls[0][0];
    const results = await Promise.allSettled(
      queries.map(query => query.queryFn({ signal: new AbortController().signal }))
    );
    expect(maxActive).toBe(4);
    expect(mockListQueryFn).toHaveBeenCalledTimes(250);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(249);
  });

  it('forwards the original tRPC query key and request context', async () => {
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds: [worktreeId] }));
    const [query]: { queryKey: unknown[]; queryFn: (context: object) => Promise<unknown> }[] =
      mockFolderQueries.mock.calls[0][0];
    const context = {
      client: {},
      queryKey: query.queryKey,
      signal: new AbortController().signal,
      meta: { source: 'folder-history' },
    };
    await query.queryFn(context);
    expect(mockListQueryFn).toHaveBeenCalledWith(context);
  });

  it('does not send a queued request after it is aborted', async () => {
    const folderWorktreeIds = Array.from(
      { length: 5 },
      (_, i) => `worktree_11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`
    );
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds }));
    const queries: { queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }[] =
      mockFolderQueries.mock.calls[0][0];
    const controller = new AbortController();
    const results = Promise.allSettled(
      queries.map(query => query.queryFn({ signal: controller.signal }))
    );
    await Promise.resolve();
    controller.abort();
    expect((await results)[4].status).toBe('rejected');
    expect(mockListQueryFn).toHaveBeenCalledTimes(4);
  });

  it('does not issue folder queries when no workspaces are filed', () => {
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds: [] }));
    expect(mockListOptions).toHaveBeenCalledTimes(1);
  });
});
