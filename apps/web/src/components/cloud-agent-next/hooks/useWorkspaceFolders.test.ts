import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toast } from 'sonner';
import { SMART_FOLDER_WORKTREE_ORDER_LIMIT } from '@/lib/cloud-agent/workspace-folders';
import { useWorkspaceFolders, type WorkspaceFolderController } from './useWorkspaceFolders';

const mockMutateAsync = jest.fn(async () => ({ success: true }));
const mockInvalidateQueries = jest.fn(async () => undefined);

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { folders: [] }, isPending: false }),
  useMutation: () => ({ mutateAsync: mockMutateAsync }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    workspaceFolders: {
      list: { queryOptions: () => ({ queryKey: ['workspaceFolders', 'list'] }) },
      ...Object.fromEntries(
        [
          'create',
          'update',
          'delete',
          'moveWorktree',
          'moveSession',
          'reorder',
          'reorderWorktrees',
        ].map(name => [name, { mutationOptions: () => ({}) }])
      ),
    },
    cliSessionsV2: {
      listWorkspaces: { pathFilter: () => ({ queryKey: ['listWorkspaces'] }) },
      worktreeDetails: { pathFilter: () => ({ queryKey: ['worktreeDetails'] }) },
    },
  }),
}));

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function folderController(): WorkspaceFolderController {
  let controller: WorkspaceFolderController | undefined;
  function Harness() {
    controller = useWorkspaceFolders('oauth/github|folder-order-test', undefined, {
      collapsedFolderIds: [],
      setCollapsedFolderIds: jest.fn(),
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!controller) throw new Error('Folder controller did not render');
  return controller;
}

beforeEach(() => jest.clearAllMocks());

describe('smart-folder order dispatch', () => {
  it('explains the size limit without dispatching or reporting a retryable failure', async () => {
    const ids = Array.from(
      { length: SMART_FOLDER_WORKTREE_ORDER_LIMIT + 1 },
      () => `worktree_${crypto.randomUUID()}`
    );
    await expect(folderController().reorderSmartFolderWorktrees('folder', ids)).resolves.toBe(
      false
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Cannot save workspace order for smart folders with more than 200 workspaces.'
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('dispatches the full order at the server limit', async () => {
    const ids = Array.from(
      { length: SMART_FOLDER_WORKTREE_ORDER_LIMIT },
      () => `worktree_${crypto.randomUUID()}`
    );
    await expect(folderController().reorderSmartFolderWorktrees('folder', ids)).resolves.toBe(true);
    expect(mockMutateAsync).toHaveBeenCalledWith({
      organizationId: null,
      folderId: 'folder',
      worktreeIds: ids,
    });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledWith('Workspace order saved');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
