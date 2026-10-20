import React, { act, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import type { Root } from 'react-dom/client';
import type { QueryClient, QueryClientProvider as QueryProvider } from '@tanstack/react-query';
import type { MergedWorktreeCleanup as CleanupComponent } from './MergedWorktreeCleanup';
import type {
  WorktreeCleanup,
  useWorktreeCleanup as CleanupHook,
} from './hooks/useWorktreeCleanup';

type Scope = { organizationId: string | null };
type StartInput = Scope & { worktreeIds: string[] };
const mockPreview = jest.fn<Promise<{ worktreeIds: string[] }>, [Scope]>();
const mockStart = jest.fn<Promise<WorktreeCleanup>, [StartInput]>();
const mockRetry = jest.fn<Promise<WorktreeCleanup>, [Scope]>();
const mockGet = jest.fn<Promise<WorktreeCleanup | null>, [Scope]>();
const cleanupKey = (scope: Scope) => ['cleanup', scope];

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      mergedWorktreeCleanupPreview: {
        queryOptions: (scope: Scope) => ({
          queryKey: ['preview', scope],
          queryFn: () => mockPreview(scope),
        }),
      },
      startMergedWorktreeCleanup: {
        mutationOptions: (options: object) => ({
          mutationFn: (input: StartInput) => mockStart(input),
          ...options,
        }),
      },
      retryWorktreeCleanup: {
        mutationOptions: (options: object) => ({
          mutationFn: (input: Scope) => mockRetry(input),
          ...options,
        }),
      },
      getWorktreeCleanup: {
        queryKey: (scope: Scope) => cleanupKey(scope),
        queryOptions: (scope: Scope) => ({
          queryKey: cleanupKey(scope),
          queryFn: () => mockGet(scope),
        }),
      },
    },
  }),
}));

jest.mock('@/components/ui/alert-dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const context = react.createContext<(open: boolean) => void>(() => {});
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => (open ? react.createElement(context.Provider, { value: onOpenChange }, children) : null),
    AlertDialogContent: ({ children }: { children: ReactNode }) =>
      react.createElement('div', { role: 'dialog' }, children),
    AlertDialogTitle: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogHeader: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogAction: ({ children, ...props }: React.ComponentProps<'button'>) =>
      react.createElement('button', props, children),
    AlertDialogCancel: ({ children, ...props }: React.ComponentProps<'button'>) => {
      const onOpenChange = react.useContext(context);
      return react.createElement(
        'button',
        { ...props, onClick: () => onOpenChange(false) },
        children
      );
    },
  };
});

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
  if (!container) throw new Error('Cleanup test root missing');
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

function batch(statuses: WorktreeCleanup['items'][number]['status'][]): WorktreeCleanup {
  return {
    id: 'batch-1',
    createdAt: '2026-10-20T12:00:00.000Z',
    items: statuses.map((status, index) => ({
      worktreeId: `worktree_${index}`,
      status,
      deletedSessionIds: status === 'deleted' ? [`session-${index}`, `child-${index}`] : [],
      error: status === 'failed' ? 'Sandbox cleanup failed' : null,
    })),
  };
}

describe('merged workspace cleanup', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let client: QueryClient;
  let Provider: typeof QueryProvider;
  let MergedWorktreeCleanup: typeof CleanupComponent;
  let useWorktreeCleanup: typeof CleanupHook;

  async function advance(milliseconds = 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(milliseconds);
    });
  }

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(React.createElement(Provider, { client }, element));
    });
    await advance();
    await advance();
  }

  function button(label: string) {
    const result = Array.from(dom.container.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === label
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  async function click(label: string) {
    await act(async () => {
      button(label).dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    await advance();
    await advance();
  }

  async function renderCleanup(
    overrides: Partial<React.ComponentProps<typeof CleanupComponent>> = {}
  ) {
    await render(
      React.createElement(MergedWorktreeCleanup, {
        cleanup: null,
        statusError: null,
        statusLoading: false,
        ...overrides,
      })
    );
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    dom = installDom();
    const query = await import('@tanstack/react-query');
    expect(query.isServer).toBe(false);
    Provider = query.QueryClientProvider;
    client = new query.QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.container);
    ({ MergedWorktreeCleanup } = await import('./MergedWorktreeCleanup'));
    ({ useWorktreeCleanup } = await import('./hooks/useWorktreeCleanup'));
    mockPreview.mockReset().mockResolvedValue({ worktreeIds: ['eligible-a', 'eligible-b'] });
    mockStart.mockReset().mockResolvedValue(batch(['pending', 'pending']));
    mockRetry.mockReset().mockResolvedValue(batch(['pending']));
    mockGet.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    dom.cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([undefined, 'org-123'])(
    'confirms count, destructive scope and frozen IDs for %s',
    async organizationId => {
      await renderCleanup({ organizationId });
      expect(mockPreview).not.toHaveBeenCalled();
      await click('Clean up merged workspaces');
      expect(mockPreview).toHaveBeenCalledWith({ organizationId: organizationId ?? null });
      expect(dom.container.textContent).toContain('Permanently delete 2 workspaces');
      expect(dom.container.textContent).toContain('including all chats and files');
      expect(dom.container.textContent).toContain('regardless of sidebar filters');
      expect(dom.container.textContent).toContain('unmerged or unverified pull requests are kept');
      expect(dom.container.textContent).toContain('even if you close this tab');
      expect(mockStart).not.toHaveBeenCalled();
      mockPreview.mockResolvedValue({ worktreeIds: ['newly-eligible'] });
      await click('Delete 2 workspaces');
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledWith({
        organizationId: organizationId ?? null,
        worktreeIds: ['eligible-a', 'eligible-b'],
      });
      expect(client.getQueryData(cleanupKey({ organizationId: organizationId ?? null }))).toEqual(
        batch(['pending', 'pending'])
      );
      expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    }
  );

  it('keeps delete disabled while preview loads and when no workspaces are eligible', async () => {
    const preview = Promise.withResolvers<{ worktreeIds: string[] }>();
    mockPreview.mockReturnValue(preview.promise);
    await renderCleanup();
    await click('Clean up merged workspaces');
    expect(dom.container.textContent).toContain('Checking your workspaces');
    expect(button('Delete 0 workspaces').disabled).toBe(true);
    await act(async () => preview.resolve({ worktreeIds: [] }));
    await advance();
    expect(dom.container.textContent).toContain('No workspaces with merged pull requests');
    expect(button('Delete 0 workspaces').disabled).toBe(true);
    await click('Delete 0 workspaces');
    expect(mockStart).not.toHaveBeenCalled();
    await click('Cancel');
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('blocks duplicate starts and cancellation while the start mutation is pending', async () => {
    const start = Promise.withResolvers<WorktreeCleanup>();
    mockStart.mockReturnValue(start.promise);
    await renderCleanup();
    await click('Clean up merged workspaces');
    await click('Delete 2 workspaces');
    expect(button('Starting cleanup...').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Clean up merged workspaces').disabled).toBe(true);
    await click('Starting cleanup...');
    await click('Cancel');
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(dom.container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => start.resolve(batch(['pending'])));
    await advance();
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps preview failures cancellable and retries the query on reopening', async () => {
    mockPreview.mockRejectedValueOnce(new Error('Preview unavailable'));
    await renderCleanup();
    await click('Clean up merged workspaces');
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Connection failed. Please retry in a moment.'
    );
    expect(button('Delete 0 workspaces').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
    await click('Cancel');
    await click('Clean up merged workspaces');
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(button('Delete 2 workspaces').disabled).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('keeps a failed start open and actionable for another attempt', async () => {
    mockStart.mockRejectedValueOnce(new Error('Start unavailable'));
    await renderCleanup();
    await click('Clean up merged workspaces');
    await click('Delete 2 workspaces');
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Connection failed. Please retry in a moment.'
    );
    expect(button('Delete 2 workspaces').disabled).toBe(false);
    expect(button('Cancel').disabled).toBe(false);
    await click('Delete 2 workspaces');
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows structural progress-query errors without stranding the cleanup action', async () => {
    await renderCleanup({ statusError: { message: 'Progress unavailable' } });
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'It will refresh automatically'
    );
    expect(button('Clean up merged workspaces').disabled).toBe(false);
    await click('Clean up merged workspaces');
    expect(button('Delete 2 workspaces').disabled).toBe(false);
  });

  it('disables cleanup during initial status loading and active batches', async () => {
    await renderCleanup({ statusLoading: true });
    expect(button('Clean up merged workspaces').disabled).toBe(true);
    await renderCleanup({ cleanup: batch(['deleted', 'pending', 'deleting', 'failed']) });
    expect(button('Cleaning up merged workspaces...').disabled).toBe(true);
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
      '1 of 4 workspaces deleted, 1 failed'
    );
    expect(dom.container.textContent).toContain('You can close this tab.');
    expect(button('Retry failed cleanup').disabled).toBe(true);
    await renderCleanup({ cleanup: batch(['deleted', 'deleted']) });
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
      '2 of 2 workspaces deleted'
    );
    expect(dom.container.textContent).not.toContain('You can close this tab.');
    expect(button('Clean up merged workspaces').disabled).toBe(false);
  });

  it('retries failures through the scoped retry endpoint and leaves retry errors actionable', async () => {
    const retry = Promise.withResolvers<WorktreeCleanup>();
    mockRetry
      .mockRejectedValueOnce(new Error('Retry unavailable'))
      .mockReturnValueOnce(retry.promise);
    await renderCleanup({ organizationId: 'org-123', cleanup: batch(['deleted', 'failed']) });
    expect(dom.container.textContent).toContain('1 of 2 workspaces deleted, 1 failed');
    expect(dom.container.querySelector('details')?.textContent).toContain(
      'worktree_1: Sandbox cleanup failed'
    );
    await click('Retry failed cleanup');
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Connection failed. Please retry in a moment.'
    );
    expect(button('Retry failed cleanup').disabled).toBe(false);
    await click('Retry failed cleanup');
    expect(button('Retrying...').disabled).toBe(true);
    await click('Retrying...');
    expect(mockRetry).toHaveBeenCalledTimes(2);
    expect(mockRetry).toHaveBeenLastCalledWith({ organizationId: 'org-123' });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
    await act(async () => retry.resolve(batch(['pending'])));
    await advance();
    expect(client.getQueryData(cleanupKey({ organizationId: 'org-123' }))).toEqual(
      batch(['pending'])
    );
  });

  it('clears a previous retry error after starting a new batch', async () => {
    mockRetry.mockRejectedValueOnce(new Error('Retry unavailable'));
    await renderCleanup({ cleanup: batch(['failed']) });
    await click('Retry failed cleanup');
    expect(dom.container.querySelector('[role="alert"]')).not.toBeNull();

    await click('Clean up merged workspaces');
    await click('Delete 2 workspaces');
    await renderCleanup({ cleanup: { ...batch(['failed']), id: 'batch-2' } });
    expect(dom.container.textContent).toContain('0 of 1 workspaces deleted, 1 failed');
    expect(button('Retry failed cleanup').disabled).toBe(false);
    expect(dom.container.querySelector('[role="alert"]')).toBeNull();
    await click('Retry failed cleanup');
    expect(mockRetry).toHaveBeenCalledTimes(2);
  });

  function HookHarness(props: Parameters<typeof CleanupHook>[0]) {
    const result = useWorktreeCleanup(props);
    return React.createElement(
      'output',
      null,
      result.error?.message ?? result.data?.items.map(item => item.status).join(',')
    );
  }

  it('polls active work every 2 seconds and terminal batches every 30 seconds', async () => {
    mockGet.mockResolvedValue(batch(['pending']));
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    await render(React.createElement(HookHarness, { organizationId: 'org-123', onDeleted }));
    expect(mockGet).toHaveBeenCalledWith({ organizationId: 'org-123' });
    expect(mockGet).toHaveBeenCalledTimes(1);
    mockGet.mockResolvedValue(batch(['deleting']));
    await advance(2000);
    await advance();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(dom.container.textContent).toBe('deleting');
    mockGet.mockResolvedValue(batch(['deleted']));
    await advance(2000);
    await advance();
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(dom.container.textContent).toBe('deleted');
    expect(onDeleted).toHaveBeenCalledWith('worktree_0', ['session-0', 'child-0']);
    await advance(29_000);
    expect(mockGet).toHaveBeenCalledTimes(3);
    await advance(1000);
    await advance();
    expect(mockGet).toHaveBeenCalledTimes(4);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('reconciles deleted items once per batch across layout remounts', async () => {
    const data = batch(['deleted', 'failed', 'pending']);
    mockGet.mockResolvedValue(data);
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    const element = React.createElement(HookHarness, { onDeleted });
    await render(element);
    expect(mockGet).toHaveBeenCalledWith({ organizationId: null });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await act(async () => {
      client.setQueryData(cleanupKey({ organizationId: null }), { ...data, createdAt: 'later' });
    });
    await advance();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await render(React.createElement(React.Fragment));
    await render(element);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenLastCalledWith('worktree_0', ['session-0', 'child-0']);
    await act(async () => {
      client.setQueryData(cleanupKey({ organizationId: null }), { ...data, id: 'batch-2' });
    });
    await advance();
    expect(onDeleted).toHaveBeenCalledTimes(2);
  });

  it('reconciles deletions completed while the layout was unmounted', async () => {
    mockGet.mockResolvedValue(batch(['deleted', 'pending']));
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    const element = React.createElement(HookHarness, { onDeleted });
    await render(element);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await render(React.createElement(React.Fragment));
    mockGet.mockResolvedValue(batch(['deleted', 'deleted']));
    await render(element);
    expect(onDeleted).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenLastCalledWith('worktree_1', ['session-1', 'child-1']);
  });

  it('reconciles persisted results again with a fresh query client', async () => {
    mockGet.mockResolvedValue(batch(['deleted']));
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    const element = React.createElement(HookHarness, { onDeleted });
    await render(element);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await render(React.createElement(React.Fragment));
    client.clear();
    const { QueryClient } = await import('@tanstack/react-query');
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    await render(element);
    expect(onDeleted).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenLastCalledWith('worktree_0', ['session-0', 'child-0']);
  });

  it('keeps reconciliation isolated between personal and organization scopes', async () => {
    mockGet.mockResolvedValue(batch(['deleted']));
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    await render(React.createElement(HookHarness, { onDeleted }));
    await render(React.createElement(HookHarness, { organizationId: 'org-123', onDeleted }));
    expect(onDeleted).toHaveBeenCalledTimes(2);
    await render(React.createElement(HookHarness, { onDeleted }));
    expect(onDeleted).toHaveBeenCalledTimes(2);
  });

  it('continues polling after status-query errors and discovers background cleanup from an empty scope', async () => {
    mockGet.mockRejectedValueOnce(new Error('Status temporarily unavailable'));
    const onDeleted = jest.fn().mockResolvedValue(undefined);
    await render(React.createElement(HookHarness, { onDeleted }));
    expect(dom.container.textContent).toBe('Status temporarily unavailable');
    await advance(30_000);
    await advance();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(dom.container.textContent).toBe('');
    mockGet.mockResolvedValue(batch(['pending']));
    await advance(30_000);
    await advance();
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(dom.container.textContent).toBe('pending');
    mockGet.mockResolvedValue(batch(['deleted']));
    await advance(2000);
    await advance();
    expect(dom.container.textContent).toBe('deleted');
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate reconciliation while local deletion is still in flight', async () => {
    const reconciliation = Promise.withResolvers<void>();
    const onDeleted = jest.fn().mockReturnValue(reconciliation.promise);
    const data = batch(['deleted']);
    mockGet.mockResolvedValue(data);
    await render(React.createElement(HookHarness, { onDeleted }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await act(async () => {
      client.setQueryData(cleanupKey({ organizationId: null }), {
        ...data,
        createdAt: 'new-snapshot',
      });
    });
    await advance();
    await advance(30_000);
    await advance();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await render(React.createElement(React.Fragment));
    await render(React.createElement(HookHarness, { onDeleted }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await act(async () => reconciliation.resolve());
    await advance(30_000);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('uses the latest reconciliation callback and allows a failed reconciliation to retry', async () => {
    const data = batch(['pending']);
    mockGet.mockResolvedValue(data);
    const first = jest.fn().mockResolvedValue(undefined);
    const latest = jest
      .fn()
      .mockRejectedValueOnce(new Error('Local store unavailable'))
      .mockResolvedValue(undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render(React.createElement(HookHarness, { onDeleted: first }));
      await render(React.createElement(HookHarness, { onDeleted: latest }));
      mockGet.mockResolvedValue(batch(['deleted']));
      await advance(2000);
      await advance();
      expect(first).not.toHaveBeenCalled();
      expect(latest).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to reconcile deleted workspace:',
        expect.any(Error)
      );
      await render(React.createElement(React.Fragment));
      await render(React.createElement(HookHarness, { onDeleted: latest }));
      expect(latest).toHaveBeenCalledTimes(2);
      await act(async () => {
        client.setQueryData(cleanupKey({ organizationId: null }), {
          ...batch(['deleted']),
          createdAt: 'new-snapshot',
        });
      });
      await advance();
      expect(latest).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});
