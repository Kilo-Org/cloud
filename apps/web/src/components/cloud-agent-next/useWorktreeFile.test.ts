import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { useWorktreeFile as UseWorktreeFile } from './useWorktreeFile';
import { getWorktreeChangesQueryKey, getWorktreeFileQueryKey } from './worktree-changes';

type Scope = Parameters<typeof UseWorktreeFile>[0];
type ReadOptions = { signal?: AbortSignal | null; context?: Record<string, unknown> };
const readChanges =
  jest.fn<
    (
      input: { cloudAgentSessionId: string; organizationId?: string },
      options: ReadOptions
    ) => Promise<GetWorktreeChangesOutput>
  >();
const readFile = jest.fn<
  (
    input: {
      cloudAgentSessionId: string;
      organizationId?: string;
      path: string;
      expectedRevision: number;
    },
    options: ReadOptions
  ) => Promise<GetWorktreeFileOutput>
>();

jest.mock('@/lib/trpc/utils', () => ({
  useRawTRPCClient: () => ({
    cloudAgentNext: {
      getWorktreeChanges: { query: readChanges },
      getWorktreeFile: { query: readFile },
    },
    organizations: {
      cloudAgentNext: {
        getWorktreeChanges: { query: readChanges },
        getWorktreeFile: { query: readFile },
      },
    },
  }),
}));

let useWorktreeFile: typeof UseWorktreeFile;

beforeAll(async () => {
  ({ useWorktreeFile } = await import('./useWorktreeFile'));
});

function saved(revision: number): GetWorktreeChangesOutput {
  return {
    snapshot: {
      schemaVersion: 2,
      revision,
      capturedAt: '2026-10-14T12:00:00.000Z',
      comparison: { baseRef: 'origin/main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
      files: [
        {
          path: 'src/file.ts',
          revision,
          status: 'modified',
          additions: 1,
          deletions: 1,
          tracked: true,
          binary: false,
          countsComplete: true,
        },
      ],
      truncated: false,
    },
  };
}

function file(revision: number, path = 'src/file.ts'): GetWorktreeFileOutput {
  return {
    status: 'available',
    capturedAt: '2026-10-14T12:00:00.000Z',
    comparison: { baseRef: 'origin/main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
    file: {
      schemaVersion: 1,
      revision,
      path,
      diff: { status: 'available', patch: '@@ -1 +1 @@\n-old\n+new' },
      content: { status: 'available', source: 'current', text: `revision ${revision}` },
    },
  };
}

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { parseHTML } = requireFromNext('linkedom') as {
    parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
  };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const replacements = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, globals[name]);
    globals[name] = value;
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return { container, cleanup: () => previous.forEach((value, name) => (globals[name] = value)) };
}

describe('worktree-scoped saved changes and file hooks', () => {
  const scope: Scope = {
    cloudAgentSessionId: 'workspace-chat-a',
    worktreeId: 'worktree-a',
    path: 'src/file.ts',
  };
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let queryClient: QueryClient;
  const results = new Map<string, ReturnType<typeof useWorktreeFile>>();

  function Harness(props: Scope) {
    const result = useWorktreeFile(props);
    results.set(props.cloudAgentSessionId, result);
    return null;
  }

  function render(scopes: Scope[]) {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          scopes.map(props => createElement(Harness, { ...props, key: props.cloudAgentSessionId }))
        )
      )
    );
  }

  async function settle() {
    for (let index = 0; index < 4; index++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
  }

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0 } },
    });
    results.clear();
    readChanges.mockReset().mockResolvedValue(saved(3));
    readFile
      .mockReset()
      .mockImplementation(async input => file(input.expectedRevision, input.path));
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    dom.cleanup();
  });

  it.each([undefined, 'organization-a'])(
    'reuses sibling caches and propagates newer revisions in scope %s using the selected session for access',
    async organizationId => {
      const first = { ...scope, organizationId };
      const sibling = { ...first, cloudAgentSessionId: 'workspace-chat-b' };
      render([first]);
      await settle();
      expect(results.get(first.cloudAgentSessionId)?.state).toEqual(file(3));
      expect(readFile).toHaveBeenCalledTimes(1);

      const latest = Promise.withResolvers<GetWorktreeChangesOutput>();
      readChanges.mockReturnValueOnce(latest.promise);
      render([first, sibling]);
      expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual(file(3));
      expect(readChanges).toHaveBeenLastCalledWith(
        {
          cloudAgentSessionId: sibling.cloudAgentSessionId,
          ...(organizationId ? { organizationId } : {}),
        },
        { signal: expect.any(AbortSignal), context: { skipBatch: true } }
      );
      expect(readFile).toHaveBeenCalledTimes(1);

      latest.resolve(saved(4));
      await settle();
      expect(readFile).toHaveBeenCalledTimes(2);
      for (const chat of [first, sibling]) {
        expect(results.get(chat.cloudAgentSessionId)?.state).toEqual(file(4));
        expect(queryClient.getQueryData(getWorktreeChangesQueryKey(chat))).toEqual(saved(4));
        expect(
          queryClient.getQueryData(getWorktreeFileQueryKey({ ...chat, expectedRevision: 3 }))
        ).toEqual(file(3));
        expect(
          queryClient.getQueryData(getWorktreeFileQueryKey({ ...chat, expectedRevision: 4 }))
        ).toEqual(file(4));
      }

      render([sibling]);
      await act(async () => {
        await results.get(sibling.cloudAgentSessionId)?.reload();
      });
      await settle();
      expect(readChanges.mock.calls.at(-1)?.[0]).toEqual({
        cloudAgentSessionId: sibling.cloudAgentSessionId,
        ...(organizationId ? { organizationId } : {}),
      });
      expect(readFile.mock.calls.at(-1)?.[0]).toEqual({
        cloudAgentSessionId: sibling.cloudAgentSessionId,
        path: scope.path,
        expectedRevision: 4,
        ...(organizationId ? { organizationId } : {}),
      });
      expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual(file(4));
    }
  );

  it('keeps cached files while switching the selected session in a mounted hook', async () => {
    const select = (props: Scope) => {
      act(() =>
        root.render(
          createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, props))
        )
      );
    };
    select(scope);
    await settle();
    const sibling = { ...scope, cloudAgentSessionId: 'workspace-chat-b' };
    select(sibling);
    expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual(file(3));
    expect(readFile).toHaveBeenCalledTimes(1);

    readChanges.mockResolvedValue(saved(4));
    await act(async () => {
      await results.get(sibling.cloudAgentSessionId)?.reload();
    });
    await settle();
    expect(readChanges.mock.calls.at(-1)?.[0]).toEqual({
      cloudAgentSessionId: sibling.cloudAgentSessionId,
    });
    expect(readFile.mock.calls.at(-1)?.[0]).toEqual({
      cloudAgentSessionId: sibling.cloudAgentSessionId,
      path: sibling.path,
      expectedRevision: 4,
    });
    expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual(file(4));
  });

  it('reuses an unchanged file revision when the shared manifest advances', async () => {
    const sibling = { ...scope, cloudAgentSessionId: 'workspace-chat-b' };
    render([scope, sibling]);
    await settle();
    expect(readFile).toHaveBeenCalledTimes(1);
    act(() => {
      queryClient.setQueryData<GetWorktreeChangesOutput>(
        getWorktreeChangesQueryKey(scope),
        previous =>
          previous?.snapshot ? { snapshot: { ...previous.snapshot, revision: 4 } } : previous
      );
    });
    await settle();
    expect(queryClient.getQueryData(getWorktreeChangesQueryKey(sibling))).toMatchObject({
      snapshot: { revision: 4 },
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(results.get(scope.cloudAgentSessionId)?.state).toEqual(file(3));
    expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual(file(3));
  });

  it.each([
    { worktreeId: 'worktree-b' },
    { organizationId: 'organization-b' },
    { organizationId: undefined },
  ])('does not reuse another worktree or organization cache: %p', async overrides => {
    const first = { ...scope, organizationId: 'organization-a' };
    render([first]);
    await settle();
    readChanges.mockResolvedValue(saved(1));
    const other = { ...first, ...overrides, cloudAgentSessionId: 'workspace-chat-b' };
    render([first, other]);
    expect(results.get(other.cloudAgentSessionId)?.state).toEqual({ status: 'loading' });
    await settle();
    expect(results.get(first.cloudAgentSessionId)?.state).toEqual(file(3));
    expect(results.get(other.cloudAgentSessionId)?.state).toEqual(file(1));
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('keeps session caches separate when worktreeId is unavailable', async () => {
    const first = { ...scope, worktreeId: undefined };
    render([first]);
    await settle();
    const sibling = { ...first, cloudAgentSessionId: 'workspace-chat-b' };
    render([first, sibling]);
    expect(results.get(sibling.cloudAgentSessionId)?.state).toEqual({ status: 'loading' });
    await settle();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it.each(['changes', 'file'])('aborts an unobserved %s request', async pending => {
    if (pending === 'changes') readChanges.mockReturnValue(new Promise(() => {}));
    else readFile.mockReturnValue(new Promise(() => {}));
    render([scope]);
    await settle();
    const signal =
      pending === 'changes'
        ? readChanges.mock.calls[0]?.[1].signal
        : readFile.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);
    render([]);
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    { status: 403, reads: 1 },
    { status: 503, reads: 3 },
  ])(
    'preserves summary error handling and bounded retries for HTTP $status',
    async ({ status, reads }) => {
      readChanges.mockRejectedValue(
        Object.assign(new Error('Saved read failed'), { data: { httpStatus: status } })
      );
      render([scope]);
      await settle();
      expect(readChanges).toHaveBeenCalledTimes(reads);
      expect(readFile).not.toHaveBeenCalled();
      expect(results.get(scope.cloudAgentSessionId)?.state).toEqual({ status: 'error' });
    }
  );

  it('surfaces file errors without automatically retrying', async () => {
    readFile.mockRejectedValue(new Error('File read failed'));
    render([scope]);
    await settle();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(results.get(scope.cloudAgentSessionId)?.state).toEqual({ status: 'error' });
  });
});
