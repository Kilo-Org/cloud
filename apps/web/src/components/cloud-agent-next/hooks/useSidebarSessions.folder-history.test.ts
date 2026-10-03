import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSidebarSessions } from './useSidebarSessions';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const mockListOptions = jest.fn((input, options) => ({ input, ...options }));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: { queryOptions: mockListOptions, pathFilter: jest.fn() },
      search: { queryOptions: jest.fn(() => ({})), queryKey: jest.fn() },
      worktreeDetails: { queryOptions: jest.fn(() => ({})) },
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
  useQueries: ({
    queries,
    combine,
  }: {
    queries: unknown[];
    combine: (queries: { isLoading: boolean; isError: boolean }[]) => unknown;
  }) => combine(queries.map(() => ({ isLoading: false, isError: false }))),
}));

function Sidebar(props: NonNullable<Parameters<typeof useSidebarSessions>[0]>) {
  useSidebarSessions(props);
  return null;
}

describe('sidebar folder history queries', () => {
  beforeEach(() => mockListOptions.mockClear());

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

  it('does not issue folder queries when no workspaces are filed', () => {
    renderToStaticMarkup(createElement(Sidebar, { folderWorktreeIds: [] }));
    expect(mockListOptions).toHaveBeenCalledTimes(1);
  });
});
