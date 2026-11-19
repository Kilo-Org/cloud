import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import type { WorkspaceSummary } from '@/lib/cloud-agent/workspace-read-model';
import { useClosedWorktreeChatTabs } from './useClosedWorktreeChatTabs';

const WORKTREE = 'worktree_11111111-1111-4111-8111-111111111111';
const STORAGE_KEY = 'cloud-agent:closed-worktree-chat-tabs:user:synthetic:personal';
const LIST_KEY = ['listWorkspaces'];
const SUMMARY_KEY = ['workspaceSummaries'];
const mockClose = jest.fn();
const mockReopen = jest.fn();
const mockReorder = jest.fn();
const mockReplace = jest.fn();
const mockImport = jest.fn();
const mockError = jest.fn();
const mockSummaries = jest.fn();
type WorkspaceCache =
  | { workspaces: WorkspaceSummary[] }
  | InfiniteData<{ workspaces: WorkspaceSummary[] }>;
const mockTrpc = {
  cliSessionsV2: {
    closeWorkspaceTab: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => mockClose(input) }),
    },
    reopenWorkspaceTab: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => mockReopen(input) }),
    },
    reorderWorkspaceTab: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => mockReorder(input) }),
    },
    replaceWorkspaceTab: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => mockReplace(input) }),
    },
    importWorkspaceTabs: {
      mutationOptions: () => ({ mutationFn: (input: unknown) => mockImport(input) }),
    },
    listWorkspaces: { pathFilter: () => ({ queryKey: LIST_KEY }) },
    workspaceSummaries: {
      pathFilter: () => ({ queryKey: SUMMARY_KEY }),
      queryOptions: (input: unknown) => ({
        queryKey: [...SUMMARY_KEY, { input }],
        queryFn: () => mockSummaries(input),
      }),
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockError(...args) } }));

function summary(openIds: string[], closedIds: string[] = []): WorkspaceSummary {
  const chat = (sessionId: string) => ({
    sessionId,
    title: sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    cloudAgentSessionId: null,
    sessionStatus: null,
    sessionStatusUpdatedAt: null,
  });
  return {
    worktreeId: WORKTREE,
    openChats: openIds.map(chat),
    closedChats: closedIds.map(chat),
    latestOpenSessionId: openIds[0] ?? null,
  } as WorkspaceSummary;
}

function installDom() {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere('linkedom') as {
    parseHTML: (html: string) => { window: typeof globalThis };
  };
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  Object.assign(window, { localStorage });
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
    storage,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('server-backed workspace chat tabs', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let probe: ReturnType<typeof useClosedWorktreeChatTabs> | undefined;
  let firstClosed: string[] | undefined;

  function Probe({
    storageKey = STORAGE_KEY,
    organizationId = null,
  }: {
    storageKey?: string | null;
    organizationId?: string | null;
  }) {
    const { data } = useQuery<WorkspaceCache>({
      queryKey: LIST_KEY,
      queryFn: async () => ({ workspaces: [] }),
      enabled: false,
    });
    const workspaces = data
      ? 'pages' in data
        ? data.pages.flatMap(page => page.workspaces)
        : data.workspaces
      : [];
    probe = useClosedWorktreeChatTabs(storageKey, { organizationId, workspaces });
    firstClosed ??= [...probe.closedSessionIds];
    return null;
  }

  async function render(props: Parameters<typeof Probe>[0] = {}) {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe, props))
      );
    });
  }

  async function flush() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  beforeAll(() => {
    dom = installDom();
  });
  afterAll(() => dom.cleanup());
  beforeEach(() => {
    jest.clearAllMocks();
    for (const mutation of [mockClose, mockReopen, mockReorder, mockReplace, mockImport]) {
      mutation.mockReset().mockResolvedValue({ worktreeIds: [WORKTREE] });
    }
    mockSummaries.mockReset().mockResolvedValue({ workspaces: [] });
    dom.storage.clear();
    probe = undefined;
    firstClosed = undefined;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(LIST_KEY, { workspaces: [summary(['a', 'b'], ['closed'])] });
    root = createRoot(dom.container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
  });

  it('uses prefetched closed tabs on the first render and skips import without a legacy key', async () => {
    await render();
    expect(firstClosed).toEqual(['closed']);
    expect(probe?.isReady).toBe(true);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('patches React Query optimistically without writing browser storage', async () => {
    let finish: (value: { worktreeIds: string[] }) => void = () => undefined;
    mockClose.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    await render();
    await act(async () => probe?.closeChatTab('b'));
    await flush();
    expect(probe?.closedSessionIds).toEqual(['closed', 'b']);
    expect(mockClose).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      sessionId: 'b',
    });
    expect(dom.storage.size).toBe(0);
    await act(async () => finish({ worktreeIds: [WORKTREE] }));
  });

  it('rolls back a failed optimistic mutation and requests reconciliation', async () => {
    mockReopen.mockRejectedValue(new Error('synthetic failure'));
    const fetch = jest.spyOn(queryClient, 'fetchQuery');
    await render();
    await act(async () => probe?.openChatTab('closed'));
    await flush();
    expect(probe?.closedSessionIds).toEqual(['closed']);
    expect(mockError).toHaveBeenCalledWith('Could not save chat tabs. Please try again.');
    expect(fetch).toHaveBeenCalled();
  });

  it('keeps a tab closed when a server refresh arrives before its close commits', async () => {
    let finish: (value: { worktreeIds: string[] }) => void = () => undefined;
    mockClose.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    mockSummaries.mockResolvedValue({ workspaces: [summary(['a'], ['b', 'closed'])] });
    await render();
    await act(async () => probe?.closeChatTab('b'));
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, { workspaces: [summary(['a', 'b'], ['closed'])] });
    });
    await flush();
    expect(probe?.closedSessionIds).toContain('b');
    await act(async () => finish({ worktreeIds: [WORKTREE] }));
    await flush();
    expect(probe?.closedSessionIds).toEqual(['closed', 'b']);
  });

  it('patches infinite workspace pages and direct summaries without losing response metadata', async () => {
    queryClient.setQueryData(LIST_KEY, {
      pages: [{ workspaces: [summary(['a', 'b'])], totalCount: 12 }],
      pageParams: [null],
    });
    queryClient.setQueryData(SUMMARY_KEY, { workspaces: [summary(['a', 'b'])] });
    await render();
    await act(async () => probe?.closeChatTab('b'));
    await flush();
    expect(probe?.closedSessionIds).toEqual(['b']);
    expect(queryClient.getQueryData(LIST_KEY)).toMatchObject({
      pages: [
        {
          totalCount: 12,
          workspaces: [{ openChats: [{ sessionId: 'a' }], closedChats: [{ sessionId: 'b' }] }],
        },
      ],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(SUMMARY_KEY)).toMatchObject({
      workspaces: [{ closedChats: [{ sessionId: 'b' }] }],
    });
  });

  it('keeps a pending close local until a summary confirms chat membership', async () => {
    await render();
    await act(async () => probe?.closeChatTab('pending'));
    expect(probe?.closedSessionIds).toContain('pending');
    expect(mockClose).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, {
        workspaces: [summary(['a', 'b', 'pending'], ['closed'])],
      });
    });
    await flush();
    expect(mockClose).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      sessionId: 'pending',
    });
    expect(probe?.closedSessionIds).toContain('pending');
  });

  it('defers replacement until both chats have confirmed membership', async () => {
    await render();
    await act(async () => probe?.replaceChatTab(WORKTREE, 'b', 'pending', ['a', 'b']));
    expect(probe?.closedSessionIds).toContain('b');
    expect(probe?.sessionOrderByWorktree[WORKTREE]).toEqual(['a', 'pending']);
    expect(mockReplace).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, {
        workspaces: [summary(['a', 'b', 'pending'], ['closed'])],
      });
    });
    await flush();
    expect(mockReplace).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      oldSessionId: 'b',
      newSessionId: 'pending',
    });
    expect(probe?.sessionOrderByWorktree[WORKTREE]).toEqual(['a', 'pending']);
  });

  it('sends relative reorder operations', async () => {
    await render();
    await act(async () => probe?.reorderChatTab(WORKTREE, 'b', 'a'));
    await flush();
    expect(probe?.sessionOrderByWorktree[WORKTREE]).toEqual(['b', 'a']);
    expect(mockReorder).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      sessionId: 'b',
      beforeSessionId: 'a',
    });
  });

  it('persists a replacement after failed creation retries with a new chat ID', async () => {
    await render();
    await act(async () => {
      probe?.replaceChatTab(WORKTREE, 'b', 'failed-local', ['a', 'b']);
      probe?.openChatTab('failed-local');
    });
    await act(async () => {
      probe?.replaceChatTab(WORKTREE, 'failed-local', 'retried-local', ['a', 'failed-local']);
      probe?.openChatTab('retried-local');
    });
    await act(async () => {
      queryClient.setQueryData(LIST_KEY, {
        workspaces: [summary(['a', 'b', 'retried-local'], ['closed'])],
      });
    });
    await flush();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      oldSessionId: 'b',
      newSessionId: 'retried-local',
    });
    expect(probe?.closedSessionIds).toContain('b');
    expect(probe?.sessionOrderByWorktree[WORKTREE]).toEqual(['a', 'retried-local']);
    expect(JSON.stringify(mockReopen.mock.calls)).not.toContain('failed-local');
  });

  it('preserves close then reopen intent while the close request is pending', async () => {
    let finish: (value: { worktreeIds: string[] }) => void = () => undefined;
    mockClose.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    await render();
    await act(async () => {
      probe?.closeChatTab('a');
      probe?.openChatTab('a');
    });
    await flush();
    expect(probe?.closedSessionIds).not.toContain('a');
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockReopen).not.toHaveBeenCalled();
    await act(async () => finish({ worktreeIds: [WORKTREE] }));
    await flush();
    expect(mockReopen).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      sessionId: 'a',
    });
  });

  it('keeps an explicit reopen when it cancels a stale close reconciliation', async () => {
    let finishRefresh: (value: { workspaces: WorkspaceSummary[] }) => void = () => undefined;
    mockSummaries
      .mockReturnValueOnce(
        new Promise(resolve => {
          finishRefresh = resolve;
        })
      )
      .mockResolvedValue({ workspaces: [summary(['a', 'b'], ['closed'])] });
    await render();
    await act(async () => probe?.closeChatTab('a'));
    await flush();
    await act(async () => probe?.openChatTab('a'));
    expect(probe?.closedSessionIds).not.toContain('a');
    expect(mockReopen).toHaveBeenCalledTimes(1);
    await act(async () => finishRefresh({ workspaces: [summary(['b'], ['a', 'closed'])] }));
    await flush();
    expect(mockReopen).toHaveBeenCalledTimes(1);
    expect(probe?.closedSessionIds).not.toContain('a');
  });

  it('deletes the legacy key only after successful import and does not import it twice', async () => {
    let finish: (value: { worktreeIds: string[] }) => void = () => undefined;
    mockImport.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const legacy = {
      closedSessionIds: ['b', 'a'],
      sessionOrderByWorktree: { [WORKTREE]: ['b', 'a'] },
    };
    dom.storage.set(STORAGE_KEY, JSON.stringify(legacy));
    await render();
    expect(probe?.isReady).toBe(false);
    expect(probe?.closedSessionIds).toEqual(['closed']);
    expect(probe?.sessionOrderByWorktree[WORKTREE]).toEqual(['a', 'b']);
    expect(dom.storage.has(STORAGE_KEY)).toBe(true);
    expect(mockImport).toHaveBeenCalledWith({ organizationId: null, ...legacy });
    await render();
    expect(mockImport).toHaveBeenCalledTimes(1);
    await act(async () => finish({ worktreeIds: [WORKTREE] }));
    expect(dom.storage.has(STORAGE_KEY)).toBe(false);
    expect(probe?.isReady).toBe(true);
  });

  it('serializes an explicit reopen after legacy import instead of closing it again', async () => {
    let finish: (value: { worktreeIds: string[] }) => void = () => undefined;
    mockImport.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    dom.storage.set(STORAGE_KEY, JSON.stringify(['a']));
    await render();
    await act(async () => probe?.openChatTab('a'));
    expect(probe?.closedSessionIds).not.toContain('a');
    expect(mockReopen).not.toHaveBeenCalled();
    await act(async () => finish({ worktreeIds: [WORKTREE] }));
    await flush();
    expect(mockReopen).toHaveBeenCalledWith({
      organizationId: null,
      worktreeId: WORKTREE,
      sessionId: 'a',
    });
    expect(probe?.closedSessionIds).not.toContain('a');
  });

  it('retains the legacy key when import fails', async () => {
    mockImport.mockRejectedValue(new Error('synthetic import failure'));
    dom.storage.set(STORAGE_KEY, JSON.stringify(['a']));
    await render();
    await flush();
    expect(dom.storage.has(STORAGE_KEY)).toBe(true);
    expect(probe?.isReady).toBe(true);
  });

  it('does not leak pending tabs or retained callbacks into another organization scope', async () => {
    await render();
    const oldClose = probe?.closeChatTab;
    await act(async () => probe?.closeChatTab('personal-pending'));
    await render({ organizationId: '22222222-2222-4222-8222-222222222222' });
    await act(async () => oldClose?.('another-personal-pending'));
    expect(probe?.closedSessionIds).toEqual(['closed']);
    expect(mockClose).not.toHaveBeenCalled();
    await render();
    expect(probe?.isReady).toBe(true);
  });

  it('refreshes a restored page rather than reopening its active address', async () => {
    await render();
    const fetch = jest.spyOn(queryClient, 'fetchQuery');
    const event = new window.Event('pageshow');
    Object.assign(event, { persisted: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(fetch).toHaveBeenCalled();
    expect(mockReopen).not.toHaveBeenCalled();
  });
});
