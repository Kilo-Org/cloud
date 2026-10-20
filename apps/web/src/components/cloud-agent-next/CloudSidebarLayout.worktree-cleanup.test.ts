import React, { act, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import type { Root } from 'react-dom/client';
import type { CloudSidebarLayout as SidebarLayout } from './CloudSidebarLayout';
import type { WorktreeCleanup, useWorktreeCleanup } from './hooks/useWorktreeCleanup';
import type { StoredSession } from './types';

const mockPush = jest.fn();
const mockRouter = { push: mockPush, replace: jest.fn() };
let mockSearchParams = new URLSearchParams();
const mockForgetTabs = jest.fn();
const mockRemoveDeletedSession = jest.fn().mockResolvedValue(undefined);
const mockInvalidateSessions = jest.fn().mockResolvedValue(undefined);
const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);
const mockQueryClient = { invalidateQueries: mockInvalidateQueries };
let mockCleanup: {
  data: WorktreeCleanup | null;
  error: { message: string } | null;
  isPending: boolean;
};
let mockCleanupOptions: Parameters<typeof useWorktreeCleanup>[0];
const mockSessions: StoredSession[] = [];
const mockFolders = {
  folders: [],
  isLoading: false,
  refresh: jest.fn().mockResolvedValue(undefined),
};
const mockTabs = {
  closedSessionIds: [],
  sessionOrderByWorktree: {},
  openChatTab: jest.fn(),
  closeChatTab: jest.fn(),
  replaceChatTab: jest.fn(),
  forgetWorktreeTabs: mockForgetTabs,
};
const mockLocalSessions = {
  localSessions: [],
  createLocalSession: jest.fn(),
  retryLocalSession: jest.fn(),
  discardLocalSession: jest.fn(),
  settleLocalSessions: jest.fn(),
};
const mockTrpc = {
  cliSessionsV2: Object.fromEntries(
    [
      'list',
      'search',
      'recentRepositories',
      'worktreeDetails',
      'delete',
      'rename',
      'renameWorktree',
      'deleteWorktree',
    ].map(name => [
      name,
      {
        queryOptions: () => ({}),
        mutationOptions: () => ({}),
        mutationKey: () => [name],
        pathFilter: () => ({ queryKey: [name] }),
      },
    ])
  ),
  workspaceFolders: { list: { pathFilter: () => ({ queryKey: ['folders'] }) } },
};

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/cloud',
  useSearchParams: () => mockSearchParams,
}));
jest.mock('@tanstack/react-query', () => ({
  skipToken: Symbol('skip'),
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useMutationState: () => [],
  useQueryClient: () => mockQueryClient,
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockTrpc,
  useRawTRPCClient: () => ({}),
}));
jest.mock('jotai', () => ({ useAtomValue: () => null, useSetAtom: () => jest.fn() }));
jest.mock('./store/db-session-atoms', () => ({
  dbSessionsAtom: {},
  deleteSessionFromStoreAtom: {},
}));
jest.mock('./CloudAgentProvider', () => ({ useManager: () => ({ atoms: {} }) }));
jest.mock('./hooks/useSidebarSessions', () => ({
  useSidebarSessions: () => ({
    sessions: mockSessions,
    cachedSessions: mockSessions,
    worktreeDetails: {},
    loadingWorktreeIds: [],
    isLoading: false,
    refetchSessions: jest.fn(),
  }),
  deriveForegroundSessionStatus: () => null,
  mergeWorktreeChatSessions: () => [],
}));
jest.mock('./hooks/useActiveSessions', () => ({
  useActiveSessions: () => ({ activeSessions: [] }),
}));
jest.mock('./hooks/useSidebarPreferences', () => ({
  useSidebarPreferences: () => ({
    platformFilter: [],
    projectFilter: ['https://github.com/kilo/filtered'],
  }),
}));
jest.mock('./hooks/useWorkspaceFolders', () => ({ useWorkspaceFolders: () => mockFolders }));
jest.mock('./hooks/useClosedWorktreeChatTabs', () => ({
  useClosedWorktreeChatTabs: () => mockTabs,
}));
jest.mock('./local-sessions/LocalSessionsProvider', () => ({
  LocalSessionsProvider: ({ children }: { children: ReactNode }) => children,
  useLocalSessions: () => mockLocalSessions,
}));
jest.mock('./local-sessions/local-session-request', () => ({ sendLocalSessionRequest: jest.fn() }));
jest.mock('@/components/SetPageActions', () => ({ SetPageActions: () => null }));
jest.mock('./settings/CloudAgentSettingsButton', () => ({ CloudAgentSettingsButton: () => null }));
jest.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetHeader: () => null,
  SheetTitle: () => null,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: () => null,
  AlertDialogAction: () => null,
  AlertDialogCancel: () => null,
  AlertDialogContent: () => null,
  AlertDialogDescription: () => null,
  AlertDialogFooter: () => null,
  AlertDialogHeader: () => null,
  AlertDialogTitle: () => null,
}));
jest.mock('./hooks/useWorktreeCleanup', () => ({
  useWorktreeCleanup: (options: Parameters<typeof useWorktreeCleanup>[0]) => {
    mockCleanupOptions = options;
    return mockCleanup;
  },
}));
jest.mock('./MergedWorktreeCleanup', () => ({
  MergedWorktreeCleanup: ({
    organizationId,
    cleanup,
    statusError,
    statusLoading,
  }: {
    organizationId?: string;
    cleanup: WorktreeCleanup | null;
    statusError: { message: string } | null;
    statusLoading: boolean;
  }) =>
    jest.requireActual<typeof React>('react').createElement(
      'output',
      {
        'data-scope': organizationId ?? 'personal',
        'data-pending': String(statusLoading),
      },
      statusError?.message ?? cleanup?.id ?? 'No cleanup'
    ),
}));
jest.mock('./ChatSidebar', () => ({
  ChatSidebar: ({
    workspaceCleanup,
    deletingWorktreeIds,
  }: {
    workspaceCleanup: ReactNode;
    deletingWorktreeIds: string[];
  }) => {
    const react = jest.requireActual<typeof React>('react');
    return react.createElement(
      'aside',
      null,
      workspaceCleanup,
      deletingWorktreeIds.map(id =>
        react.createElement('button', { key: id, disabled: true, 'data-deleting': id }, id)
      )
    );
  },
}));
jest.mock('./session-deletion', () => ({
  ...jest.requireActual('./session-deletion'),
  removeDeletedSession: (input: object) => mockRemoveDeletedSession(input),
  invalidateSessionQueries: (input: object) => mockInvalidateSessions(input),
}));

function installDom() {
  const requireFromNext = createRequire(createRequire(__filename).resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Window & typeof globalThis; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('Sidebar cleanup test root missing');
  return {
    container,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe('CloudSidebarLayout cleanup integration', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let CloudSidebarLayout: typeof SidebarLayout;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockCleanup = { data: null, error: null, isPending: false };
    dom = installDom();
    ({ CloudSidebarLayout } = await import('./CloudSidebarLayout'));
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.cleanup();
  });

  async function render(organizationId?: string) {
    await act(async () =>
      root.render(
        React.createElement(CloudSidebarLayout, {
          currentUserId: 'user-123',
          organizationId,
          children: React.createElement('main', null, 'Chat content'),
        })
      )
    );
  }

  it('passes scope, status loading and structural errors through independently of sidebar filters', async () => {
    mockCleanup.isPending = true;
    await render('org-123');
    expect(mockCleanupOptions.organizationId).toBe('org-123');
    expect(dom.container.querySelector('output')?.getAttribute('data-scope')).toBe('org-123');
    expect(dom.container.querySelector('output')?.getAttribute('data-pending')).toBe('true');
    mockCleanup = { data: null, error: { message: 'Progress unavailable' }, isPending: false };
    await render('org-123');
    expect(dom.container.querySelector('output')?.textContent).toBe('Progress unavailable');
    expect(dom.container.textContent).toContain('Chat content');
  });

  it('marks only pending and deleting workspace rows and releases terminal rows', async () => {
    const batch: WorktreeCleanup = {
      id: 'batch-1',
      createdAt: '2026-10-20T12:00:00.000Z',
      items: (['pending', 'deleting', 'deleted', 'failed'] as const).map((status, index) => ({
        worktreeId: `worktree_${index}`,
        status,
        deletedSessionIds: [],
        error: null,
      })),
    };
    mockCleanup.data = batch;
    await render();
    expect(
      Array.from(dom.container.querySelectorAll('[data-deleting]')).map(node =>
        node.getAttribute('data-deleting')
      )
    ).toEqual(['worktree_0', 'worktree_1']);
    expect(dom.container.querySelector('output')?.textContent).toBe('batch-1');
    mockCleanup.data = {
      ...batch,
      items: batch.items.map(item => ({ ...item, status: 'deleted' })),
    };
    await render();
    expect(dom.container.querySelector('[data-deleting]')).toBeNull();
  });

  it.each([undefined, 'org-123'])(
    'reconciles all deleted chats, tabs and queries and redirects the selected scope %s',
    async organizationId => {
      const base = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { href: `https://example.com${base}/chat?sessionId=deleted-chat` },
      });
      await render(organizationId);
      await act(async () =>
        mockCleanupOptions.onDeleted('deleted-worktree', ['deleted-chat', 'deleted-child'])
      );
      expect(mockRemoveDeletedSession).toHaveBeenCalledTimes(2);
      expect(mockRemoveDeletedSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'deleted-chat',
          queryClient: mockQueryClient,
          trpc: mockTrpc,
        })
      );
      expect(mockRemoveDeletedSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'deleted-child' })
      );
      expect(mockForgetTabs).toHaveBeenCalledWith('deleted-worktree', [
        'deleted-chat',
        'deleted-child',
      ]);
      expect(mockPush).toHaveBeenCalledWith(base);
      expect(mockInvalidateSessions).toHaveBeenCalledWith({
        queryClient: mockQueryClient,
        trpc: mockTrpc,
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['folders'] });
    }
  );

  it('does not navigate away from an unrelated selection when background cleanup completes', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://example.com/cloud/chat?sessionId=surviving-chat' },
    });
    await render();
    await act(async () => mockCleanupOptions.onDeleted('deleted-worktree', ['deleted-chat']));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockForgetTabs).toHaveBeenCalledWith('deleted-worktree', ['deleted-chat']);
    expect(mockInvalidateSessions).toHaveBeenCalledTimes(1);
  });
});
