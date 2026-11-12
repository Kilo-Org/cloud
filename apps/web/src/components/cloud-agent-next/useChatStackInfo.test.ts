import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useChatStackInfo } from './useChatStackInfo';

const currentWorktreeId = 'worktree_12345678-1234-4234-9234-123456789abc';
const parentWorktreeId = 'worktree_12345678-1234-4234-9234-123456789abd';
let mockParentWorktreeId: string | null = null;
const mockUseQuery = jest.fn<{ data: undefined }, [unknown]>(() => ({ data: undefined }));
const mockQueryOptions = (input: unknown) => ({ queryKey: ['options', input] });

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useQuery: (options: unknown) => mockUseQuery(options),
  useInfiniteQuery: () => ({
    isSuccess: true,
    data: {
      pages: [
        {
          workspaces: [
            {
              worktreeId: currentWorktreeId,
              parentWorktreeId: mockParentWorktreeId,
              gitUrl: 'https://github.com/example/repo.git',
              branch: 'feature',
            },
            ...(mockParentWorktreeId
              ? [
                  {
                    worktreeId: mockParentWorktreeId,
                    parentWorktreeId: null,
                    gitUrl: 'https://github.com/example/repo.git',
                    branch: 'main',
                  },
                ]
              : []),
          ],
        },
      ],
    },
  }),
  useQueries: ({ combine }: { combine: (results: unknown[]) => unknown }) => combine([]),
}));
jest.mock('jotai', () => ({ atom: jest.fn(), useSetAtom: () => jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({}), usePathname: () => '/cloud/chat' }));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      listWorkspaces: { infiniteQueryOptions: mockQueryOptions },
      worktreeDetails: { queryOptions: mockQueryOptions },
      get: { queryOptions: mockQueryOptions },
    },
  }),
  useRawTRPCClient: () => ({}),
}));

function Probe() {
  useChatStackInfo({
    enabled: true,
    userId: 'user-1',
    currentWorktreeId,
    cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
    repository: 'example/repo',
    openSession: jest.fn(),
  });
  return null;
}

beforeEach(() => {
  mockUseQuery.mockClear();
  mockParentWorktreeId = null;
});

it('does not fetch git changes just to open a standalone workspace', () => {
  renderToStaticMarkup(createElement(Probe));
  expect(mockUseQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      queryKey: ['worktree-changes', 'user-1', null, ['worktree', currentWorktreeId]],
      enabled: false,
    })
  );
});

it('still compares a stacked workspace with its parent', () => {
  mockParentWorktreeId = parentWorktreeId;
  renderToStaticMarkup(createElement(Probe));
  expect(mockUseQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      queryKey: ['worktree-changes', 'user-1', null, ['worktree', currentWorktreeId]],
      enabled: true,
    })
  );
});
