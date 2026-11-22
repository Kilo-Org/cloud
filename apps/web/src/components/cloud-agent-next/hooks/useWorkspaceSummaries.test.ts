import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { useWorkspaceSummaryLookup, type WorkspaceSummary } from './useWorkspaceSummaries';
import { useWorkspaceChats } from './useWorkspaceChats';
import { workspaceSummaryFixture } from './workspace-summary-test-fixtures';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';

const mockSummaries = jest.fn<Promise<{ workspaces: WorkspaceSummary[] }>, [unknown]>();
const mockChats = jest.fn<
  Promise<{
    chats: (WorkspaceSummary['openChats'][number] & {
      closedPosition: number | null;
      tabPosition: number | null;
    })[];
    nextCursor: { createdAt: string; sessionId: string } | null;
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

it('uses the summary alone when it contains every tab', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const summary = workspaceSummaryFixture();
  let result: ReturnType<typeof useWorkspaceChats> | undefined;
  const cleanup = await mount(client, function Probe() {
    result = useWorkspaceChats({
      organizationId: null,
      worktreeId: cloudAgentWorktreeIdSchema.parse(summary.worktreeId),
      workspace: summary,
    });
    return null;
  });
  try {
    expect(result?.workspaceWithTabs).toBe(summary);
    expect(mockChats).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it('loads the selected workspace across pages and refreshes only when tab state or membership changes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const summary = workspaceSummaryFixture({ chatTabsTruncated: true, chatCount: 4 });
  const root = { ...summary.openChats[0], closedPosition: null, tabPosition: null };
  const cursor = { createdAt: root.createdAt, sessionId: root.sessionId };
  const earlyClosed = { ...root, sessionId: 'early-closed', closedPosition: 2 };
  const lateClosed = { ...root, sessionId: 'late-closed', closedPosition: 1 };
  const moved = { ...root, sessionId: 'moved', tabPosition: 1 };
  mockChats
    .mockResolvedValueOnce({ chats: [root, earlyClosed], nextCursor: cursor })
    .mockResolvedValueOnce({ chats: [moved, lateClosed], nextCursor: null })
    .mockResolvedValueOnce({ chats: [root, earlyClosed], nextCursor: cursor })
    .mockResolvedValueOnce({
      chats: [{ ...moved, closedPosition: 3 }, lateClosed],
      nextCursor: null,
    });
  let update: (next: WorkspaceSummary) => void = () => {};
  let result: ReturnType<typeof useWorkspaceChats> | undefined;
  const cleanup = await mount(client, function Probe() {
    const [workspace, setWorkspace] = useState(summary);
    update = setWorkspace;
    result = useWorkspaceChats({
      organizationId: null,
      worktreeId: cloudAgentWorktreeIdSchema.parse(workspace.worktreeId),
      workspace,
    });
    return null;
  });
  const flush = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  try {
    await flush();
    await flush();
    expect(mockChats).toHaveBeenNthCalledWith(2, {
      organizationId: null,
      worktreeId: summary.worktreeId,
      limit: 200,
      cursor,
    });
    expect(result?.workspaceWithTabs?.openChats.map(chat => chat.sessionId)).toEqual([
      'moved',
      'ses_root',
    ]);
    expect(result?.workspaceWithTabs?.closedChats.map(chat => chat.sessionId)).toEqual([
      'late-closed',
      'early-closed',
    ]);

    await act(async () => update({ ...summary, sessionStatus: 'busy' }));
    expect(mockChats).toHaveBeenCalledTimes(2);
    await act(async () => update({ ...summary, chatTabsRevision: 'updated' }));
    await flush();
    expect(mockChats).toHaveBeenCalledTimes(4);
    expect(result?.workspaceWithTabs?.openChats.map(chat => chat.sessionId)).toEqual(['ses_root']);
  } finally {
    await cleanup();
  }
});
