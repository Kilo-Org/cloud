import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { parseHTML } from 'linkedom';
import { useWorkspaceSummaryLookup, type WorkspaceSummary } from './useWorkspaceSummaries';
import { useWorkspaceChats } from './useWorkspaceChats';
import { workspaceChatFixture, workspaceSummaryFixture } from './workspace-summary-test-fixtures';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';

const mockSummaries = jest.fn<Promise<{ workspaces: WorkspaceSummary[] }>, [unknown]>();
const mockChats = jest.fn<
  Promise<{
    chats: (ReturnType<typeof workspaceChatFixture> & { tabClosed: boolean })[];
    nextCursor: { createdAt: string; sessionId: string; tabOrderVersion?: string } | null;
  }>,
  [unknown]
>();
function key(name: string, input?: unknown) {
  return [
    ['cliSessionsV2', name],
    { input, type: name === 'listWorkspaces' ? 'infinite' : 'query' },
  ];
}
const mockTrpc = {
  cliSessionsV2: {
    listWorkspaces: { pathFilter: () => ({ queryKey: [['cliSessionsV2', 'listWorkspaces']] }) },
    workspaceSummaries: {
      pathFilter: () => ({ queryKey: [['cliSessionsV2', 'workspaceSummaries']] }),
      queryOptions: (input: unknown) => ({
        queryKey: key('workspaceSummaries', input === skipToken ? undefined : input),
        queryFn: input === skipToken ? skipToken : () => mockSummaries(input),
      }),
    },
    workspaceChats: {
      infiniteQueryOptions: (input: unknown, options: object) => ({
        queryKey: key('workspaceChats', input === skipToken ? undefined : input),
        initialPageParam: undefined,
        queryFn:
          input === skipToken
            ? skipToken
            : ({ pageParam }: { pageParam: unknown }) =>
                mockChats({ ...(typeof input === 'object' ? input : {}), cursor: pageParam }),
        ...options,
      }),
    },
  },
};
jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

async function mount(client: QueryClient, probe: () => null) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const node = window.document.getElementById('root');
  if (!node) throw new Error('Missing test root');
  const root = createRoot(node);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(probe)));
  });
  return async () => {
    await act(async () => {
      root.unmount();
      client.clear();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    Object.assign(globalThis, previous);
  };
}

beforeEach(() => {
  mockSummaries.mockReset();
  mockChats.mockReset();
});

it('reuses cached stack summaries across filtered lists without another request', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const parent = workspaceSummaryFixture();
  const child = workspaceSummaryFixture({
    worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
    parentWorktreeId: parent.worktreeId,
    stackRootId: parent.worktreeId,
  });
  client.setQueryData(
    key('listWorkspaces', {
      organizationId: null,
      gitUrl: ['https://github.com/example/repository.git'],
    }),
    { pages: [{ workspaces: [parent, child] }], pageParams: [null] }
  );
  let received: WorkspaceSummary[] = [];
  const cleanup = await mount(client, function Probe() {
    received = useWorkspaceSummaryLookup({
      organizationId: null,
      worktreeIds: [child.worktreeId],
    }).workspaces;
    return null;
  });
  try {
    expect(received).toEqual([parent, child]);
    expect(mockSummaries).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it('requests missing ancestor chains in one batched summary query', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const parent = workspaceSummaryFixture();
  const child = workspaceSummaryFixture({
    worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
    parentWorktreeId: parent.worktreeId,
    stackRootId: parent.worktreeId,
  });
  client.setQueryData(key('listWorkspaces', { organizationId: null }), {
    pages: [{ workspaces: [child] }],
    pageParams: [null],
  });
  mockSummaries.mockResolvedValue({ workspaces: [parent] });
  const cleanup = await mount(client, function Probe() {
    useWorkspaceSummaryLookup({ organizationId: null, worktreeIds: [child.worktreeId] });
    return null;
  });
  try {
    expect(mockSummaries).toHaveBeenCalledTimes(1);
    expect(mockSummaries).toHaveBeenCalledWith({
      organizationId: null,
      worktreeIds: [parent.worktreeId],
      includeAncestors: true,
    });
  } finally {
    await cleanup();
  }
});

it('does not reuse a summary from another organization', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const summary = workspaceSummaryFixture();
  client.setQueryData(
    key('workspaceSummaries', { organizationId: 'synthetic-other-organization' }),
    { workspaces: [summary] }
  );
  mockSummaries.mockResolvedValue({ workspaces: [] });
  const cleanup = await mount(client, function Probe() {
    useWorkspaceSummaryLookup({ organizationId: null, worktreeIds: [summary.worktreeId] });
    return null;
  });
  try {
    expect(mockSummaries).toHaveBeenCalledWith({
      organizationId: null,
      worktreeIds: [summary.worktreeId],
      includeAncestors: true,
    });
  } finally {
    await cleanup();
  }
});

it('keeps a fetched stack lookup active for reconnect invalidation', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const workspace = workspaceSummaryFixture();
  mockSummaries.mockResolvedValue({ workspaces: [workspace] });
  let received: WorkspaceSummary[] = [];
  const cleanup = await mount(client, function Probe() {
    received = useWorkspaceSummaryLookup({
      organizationId: null,
      worktreeIds: [workspace.worktreeId],
    }).workspaces;
    return null;
  });
  try {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(mockSummaries).toHaveBeenCalledTimes(1);
    const active = client
      .getQueryCache()
      .findAll({ ...mockTrpc.cliSessionsV2.workspaceSummaries.pathFilter(), type: 'active' });
    expect(active).toHaveLength(1);
    mockSummaries.mockResolvedValue({ workspaces: [{ ...workspace, name: 'After reconnect' }] });
    await act(async () => {
      await client.invalidateQueries(mockTrpc.cliSessionsV2.workspaceSummaries.pathFilter());
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(mockSummaries).toHaveBeenCalledTimes(2);
    expect(received.find(row => row.worktreeId === workspace.worktreeId)?.name).toBe(
      'After reconnect'
    );
  } finally {
    await cleanup();
  }
});

it('loads open tabs immediately and only requests 20 closed tabs at a time after opening history', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const summary = workspaceSummaryFixture();
  const chat = workspaceChatFixture();
  const cursor = { createdAt: chat.createdAt, sessionId: 'ses_page_end' };
  mockChats.mockImplementation(async input => {
    if (typeof input === 'object' && input && 'tabState' in input && input.tabState === 'closed')
      return { chats: [], nextCursor: 'cursor' in input && input.cursor ? null : cursor };
    return { chats: [{ ...chat, tabClosed: false }], nextCursor: null };
  });
  let result: ReturnType<typeof useWorkspaceChats> | undefined;
  const cleanup = await mount(client, function Probe() {
    result = useWorkspaceChats({
      organizationId: null,
      worktreeId: cloudAgentWorktreeIdSchema.parse(summary.worktreeId),
      workspace: summary,
      currentSessionId: chat.sessionId,
    });
    return null;
  });
  try {
    expect(mockChats).toHaveBeenCalledTimes(1);
    expect(mockChats).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabState: 'open', limit: 50 })
    );
    await act(async () => {
      result?.requestClosedHistory();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(result?.serverChats.map(chat => chat.sessionId)).toEqual(['ses_root']);
    expect(mockChats).toHaveBeenCalledTimes(2);
    await act(async () => result?.closedPages.loadMore());
    expect(mockChats).toHaveBeenLastCalledWith({
      organizationId: null,
      worktreeId: summary.worktreeId,
      tabState: 'closed',
      limit: 20,
      cursor,
    });
  } finally {
    await cleanup();
  }
});

it('restarts closed tab paging without a cursor after CONFLICT and uses the fresh cursor', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const workspace = workspaceSummaryFixture();
  const worktreeId = cloudAgentWorktreeIdSchema.parse(workspace.worktreeId);
  const closedInput = { organizationId: null, worktreeId, tabState: 'closed', limit: 20 };
  const oldChat = { ...workspaceChatFixture({ sessionId: 'ses_old' }), tabClosed: true };
  const olderChat = { ...workspaceChatFixture({ sessionId: 'ses_older' }), tabClosed: true };
  const newestChat = { ...workspaceChatFixture({ sessionId: 'ses_newest' }), tabClosed: true };
  const staleCursor = {
    createdAt: oldChat.createdAt,
    sessionId: oldChat.sessionId,
    tabOrderVersion: 'a'.repeat(32),
  };
  const freshCursor = {
    createdAt: newestChat.createdAt,
    sessionId: newestChat.sessionId,
    tabOrderVersion: 'b'.repeat(32),
  };
  const staleThirdPageCursor = { ...staleCursor, sessionId: olderChat.sessionId };
  const freshThirdPageCursor = { ...freshCursor, sessionId: oldChat.sessionId };
  const conflict = TRPCClientError.from({
    error: {
      message: 'Workspace tabs changed',
      code: -32009,
      data: { code: 'CONFLICT', httpStatus: 409 },
    },
  });
  mockChats
    .mockResolvedValueOnce({ chats: [], nextCursor: null })
    .mockResolvedValueOnce({ chats: [oldChat], nextCursor: staleCursor })
    .mockResolvedValueOnce({ chats: [olderChat], nextCursor: staleThirdPageCursor })
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({ chats: [newestChat], nextCursor: freshCursor })
    .mockResolvedValueOnce({ chats: [oldChat], nextCursor: freshThirdPageCursor })
    .mockResolvedValueOnce({ chats: [olderChat], nextCursor: null });

  let result: ReturnType<typeof useWorkspaceChats> | undefined;
  const cleanup = await mount(client, function Probe() {
    result = useWorkspaceChats({
      organizationId: null,
      worktreeId,
      workspace,
      currentSessionId: null,
    });
    return null;
  });
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  try {
    await act(async () => result?.requestClosedHistory());
    await settle();
    expect(result?.closedPages.hasMore).toBe(true);

    await act(async () => result?.closedPages.loadMore());
    await settle();
    expect(mockChats).toHaveBeenNthCalledWith(3, { ...closedInput, cursor: staleCursor });
    expect(result?.closedChats.map(chat => chat.sessionId)).toEqual(['ses_old', 'ses_older']);

    await act(async () => result?.closedPages.loadMore());
    await settle();
    expect(mockChats).toHaveBeenNthCalledWith(4, { ...closedInput, cursor: staleThirdPageCursor });
    expect(result?.closedPages.error).toBe(true);

    await act(async () => result?.closedPages.loadMore());
    await settle();
    expect(mockChats).toHaveBeenNthCalledWith(5, { ...closedInput, cursor: undefined });
    expect(mockChats).toHaveBeenNthCalledWith(6, { ...closedInput, cursor: freshCursor });
    expect(result?.closedPages.error).toBe(false);
    expect(result?.closedChats.map(chat => chat.sessionId)).toEqual(['ses_newest', 'ses_old']);

    await act(async () => result?.closedPages.loadMore());
    await settle();
    expect(mockChats).toHaveBeenNthCalledWith(7, { ...closedInput, cursor: freshThirdPageCursor });
    expect(mockChats).toHaveBeenCalledTimes(7);
    expect(result?.closedChats.map(chat => chat.sessionId)).toEqual([
      'ses_newest',
      'ses_old',
      'ses_older',
    ]);
    expect(result?.closedPages.hasMore).toBe(false);
  } finally {
    await cleanup();
  }
});
