import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { startOfDay, subDays } from 'date-fns';
import type * as ReactQuery from '@tanstack/react-query';
import type * as Jotai from 'jotai';
import { CloudSidebarLayout } from './CloudSidebarLayout';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type QueryOptionsRecord = { path: string; input: unknown };

const mockQueryOptionsRecords: QueryOptionsRecord[] = [];
const mockRecentRepositoriesInputs: unknown[] = [];
const mockUseQueryCalls: unknown[] = [];
const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockSetPlatformFilter = jest.fn();
const mockSetProjectFilter = jest.fn();
const mockRefreshWorkspaceFolders = jest.fn(async () => {});
const mockSettleLocalSessions = jest.fn();
const mockOpenChatTab = jest.fn();
const mockCloseChatTab = jest.fn();
const mockReplaceChatTab = jest.fn();
const mockForgetWorktreeTabs = jest.fn();
const mockInvalidateQueries = jest.fn(async () => undefined);

const mockQueryClient = {
  invalidateQueries: mockInvalidateQueries,
  getQueryData: jest.fn(),
  setQueryData: jest.fn(),
  fetchQuery: jest.fn(async () => undefined),
};

const mockManager = {
  atoms: {
    activity: { __testAtom: 'activity' },
    isStreaming: { __testAtom: 'isStreaming' },
    activeQuestion: { __testAtom: 'activeQuestion' },
    activePermission: { __testAtom: 'activePermission' },
    cloudStatus: { __testAtom: 'cloudStatus' },
    pendingMessages: { __testAtom: 'pendingMessages' },
    agentStatus: { __testAtom: 'agentStatus' },
    activeSessionType: { __testAtom: 'activeSessionType' },
    fetchedSessionData: { __testAtom: 'fetchedSessionData' },
    sessionConfig: { __testAtom: 'sessionConfig' },
  },
};

function mockCreateTrpc(path: string[] = []): unknown {
  return new Proxy(function () {}, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      const nextPath = [...path, property];
      const procedurePath = nextPath.join('.');
      if (property === 'queryOptions') {
        return (input?: unknown) => {
          mockQueryOptionsRecords.push({ path: path.join('.'), input });
          if (path.join('.') === 'cliSessionsV2.recentRepositories') {
            mockRecentRepositoriesInputs.push(input);
          }
          return { __testKind: path.join('.'), queryKey: [...path], input };
        };
      }
      if (property === 'mutationOptions') {
        return () => ({ __testKind: path.join('.') });
      }
      if (property === 'queryKey') {
        return (input?: unknown) => [...path, input];
      }
      if (property === 'queryFilter') {
        return (input?: unknown) => ({ queryKey: [...path, input] });
      }
      if (property === 'pathFilter') {
        return () => ({ queryKey: [...path] });
      }
      if (property === 'infiniteQueryOptions') {
        return () => ({ __testKind: procedurePath, queryKey: [...path] });
      }
      if (property === 'infiniteQueryFilter') {
        return (input?: unknown) => ({ queryKey: [...path, input] });
      }
      return mockCreateTrpc(nextPath);
    },
  });
}

const mockTrpc = mockCreateTrpc();

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual<typeof ReactQuery>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => mockQueryClient,
    useQuery: (options: unknown) => {
      mockUseQueryCalls.push(options);
      return {
        data: undefined,
        isLoading: false,
        isPending: false,
        isError: false,
        isFetching: false,
        error: null,
        refetch: jest.fn(async () => ({ data: undefined })),
      };
    },
    useMutation: () => ({
      mutate: jest.fn(),
      mutateAsync: jest.fn(async () => undefined),
      isPending: false,
      isError: false,
      error: null,
    }),
    useInfiniteQuery: () => ({ data: undefined, isLoading: false, fetchNextPage: jest.fn() }),
  };
});

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockTrpc,
  useRawTRPCClient: () => ({}),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    prefetch: jest.fn(),
  }),
  usePathname: () => '/cloud',
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('jotai', () => ({
  ...jest.requireActual<typeof Jotai>('jotai'),
  useAtomValue: () => undefined,
  useSetAtom: () => jest.fn(),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

jest.mock('./ChatSidebar', () => ({ ChatSidebar: () => null }));

jest.mock('./settings/CloudAgentSettingsButton', () => ({
  CloudAgentSettingsButton: () => null,
}));

jest.mock('./CloudAgentProvider', () => ({
  useManager: () => mockManager,
}));

jest.mock('./local-sessions/LocalSessionsProvider', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    LocalSessionsProvider: ({ children }: { children?: ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    useLocalSessions: () => ({
      localSessions: [],
      createLocalSession: jest.fn(() => 'local-session-1'),
      retryLocalSession: jest.fn(() => undefined),
      discardLocalSession: jest.fn(),
      settleLocalSessions: mockSettleLocalSessions,
    }),
  };
});

jest.mock('./hooks/useSidebarSessions', () => ({
  useSidebarSessions: () => ({
    sessions: [],
    cachedSessions: [],
    worktreeDetails: {},
    loadingWorktreeIds: [],
    workspaceRows: [],
    workspaceOrder: [],
    workspaceRowsTruncated: false,
    isLoading: false,
    refetchSessions: jest.fn(),
    renameSessionLocally: jest.fn(),
  }),
  dbSessionToStoredSession: (session: unknown) => session,
  deriveForegroundSessionStatus: () => null,
  groupSidebarWorkspaces: () => [],
  mergeWorktreeChatSessions: () => [],
}));

jest.mock('./hooks/useActiveSessions', () => ({
  useActiveSessions: () => ({ activeSessions: [] }),
}));

jest.mock('./hooks/useSidebarPreferences', () => ({
  useSidebarPreferences: () => ({
    platformFilter: [],
    setPlatformFilter: mockSetPlatformFilter,
    projectFilter: [],
    setProjectFilter: mockSetProjectFilter,
  }),
}));

jest.mock('./hooks/useClosedWorktreeChatTabs', () => ({
  useClosedWorktreeChatTabs: () => ({
    closedSessionIds: [],
    sessionOrderByWorktree: {},
    openChatTab: mockOpenChatTab,
    closeChatTab: mockCloseChatTab,
    replaceChatTab: mockReplaceChatTab,
    forgetWorktreeTabs: mockForgetWorktreeTabs,
  }),
}));

jest.mock('./hooks/useWorkspaceFolders', () => ({
  useWorkspaceFolders: () => ({
    folders: [],
    isLoading: false,
    error: null,
    refresh: mockRefreshWorkspaceFolders,
  }),
}));

jest.mock('./hooks/useSessionDeletion', () => ({
  useSessionDeletion: () => ({
    deleteSession: jest.fn(async () => undefined),
    deletingSessionIds: new Set<string>(),
    deletingWorktreeIds: new Set<string>(),
    isDeleting: false,
  }),
}));

jest.mock('@/hooks/useResizableSidebar', () => ({
  useResizableSidebar: () => ({
    width: 320,
    startDrag: jest.fn(),
    resizeTo: jest.fn(),
  }),
}));

jest.mock('@/components/SetPageActions', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    SetPageActions: ({ children }: { children?: ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

jest.mock('@/components/ui/sheet', () => {
  const react = jest.requireActual<typeof React>('react');
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    Sheet: passthrough,
    SheetContent: passthrough,
    SheetHeader: passthrough,
    SheetTitle: passthrough,
  };
});

jest.mock('@/components/ui/alert-dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    AlertDialog: passthrough,
    AlertDialogAction: passthrough,
    AlertDialogCancel: passthrough,
    AlertDialogContent: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogHeader: passthrough,
    AlertDialogTitle: passthrough,
  };
});

const currentUserId = 'user-1';
const organizationId = '3f1c7a58-6a5d-4b0f-9c1e-5e9f0b2a7d41';

function readRecentRepositoriesInput(): { organizationId: unknown; updatedSince: unknown } {
  expect(mockRecentRepositoriesInputs).toHaveLength(1);
  const input = mockRecentRepositoriesInputs[0];
  if (typeof input !== 'object' || input === null) {
    throw new Error(`recentRepositories input is not an object: ${String(input)}`);
  }
  if (!('organizationId' in input) || !('updatedSince' in input)) {
    throw new Error(
      `recentRepositories input is missing organizationId/updatedSince: ${JSON.stringify(input)}`
    );
  }
  return { organizationId: input.organizationId, updatedSince: input.updatedSince };
}

type MountedLayout = {
  root: Root;
  cleanup: () => void;
};

async function mountLayout(props: {
  currentUserId: string;
  organizationId?: string;
}): Promise<MountedLayout> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('http://localhost/cloud'),
  });
  const container = window.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(CloudSidebarLayout, {
        ...props,
        children: createElement('div', { 'data-testid': 'children' }, 'content'),
      })
    )
  );
  return {
    root,
    cleanup() {
      act(() => root.unmount());
      Object.assign(globalThis, previous);
    },
  };
}

beforeEach(() => {
  mockQueryOptionsRecords.length = 0;
  mockRecentRepositoriesInputs.length = 0;
  mockUseQueryCalls.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  mockQueryOptionsRecords.length = 0;
  mockRecentRepositoriesInputs.length = 0;
});

describe('CloudSidebarLayout recentRepositories query input', () => {
  it('asks for personal repositories only in the personal view', async () => {
    const expectedUpdatedSince = startOfDay(subDays(new Date(), 30)).toISOString();
    const mounted = await mountLayout({ currentUserId });
    try {
      const input = readRecentRepositoriesInput();
      expect(input.updatedSince).toBe(expectedUpdatedSince);
      expect(input.organizationId).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  it('passes the organization id through in the organization view', async () => {
    const expectedUpdatedSince = startOfDay(subDays(new Date(), 30)).toISOString();
    const mounted = await mountLayout({ currentUserId, organizationId });
    try {
      const input = readRecentRepositoriesInput();
      expect(input.updatedSince).toBe(expectedUpdatedSince);
      expect(input.organizationId).toBe(organizationId);
    } finally {
      mounted.cleanup();
    }
  });
});
