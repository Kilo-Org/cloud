import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { useModelFavorites as useModelFavoritesHook } from './use-model-preferences';

type Preferences = { favorites: string[]; lastSelected: null };

const SERVER_FAVORITES = ['anthropic/claude-sonnet-4', 'remote:anthropic-local:shared/model.id'];

const mockGet = jest.fn<() => Promise<Preferences>>();
const mockAdd = jest.fn<(input: { model: string }) => Promise<{ success: boolean }>>();
const mockRemove = jest.fn<(input: { model: string }) => Promise<{ success: boolean }>>();
const mockToast = { error: jest.fn(), success: jest.fn() };

const GET_KEY = ['modelPreferences', 'get'];
const mockQueryOptions = jest.fn((input?: { organizationId?: string }) => ({
  queryKey: input ? [...GET_KEY, { input }] : [...GET_KEY],
  queryFn: mockGet,
}));

const mockTrpc = {
  modelPreferences: {
    get: {
      queryOptions: mockQueryOptions,
      queryKey: (input?: { organizationId?: string }) =>
        input ? [...GET_KEY, { input }] : [...GET_KEY],
    },
    addFavorite: {
      mutationOptions: (options?: Record<string, unknown>) => ({ ...options, mutationFn: mockAdd }),
    },
    removeFavorite: {
      mutationOptions: (options?: Record<string, unknown>) => ({
        ...options,
        mutationFn: mockRemove,
      }),
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('sonner', () => ({ toast: mockToast }));

type LinkedomModule = {
  parseHTML: (
    html: string,
    globals: { location: URL }
  ) => { window: typeof globalThis; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const { window, document } = (requireFromHere('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { location: new URL('http://localhost/') }
  );
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
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

async function settle(action: () => void = () => {}) {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

// React schedules the probe re-render on a macrotask that can land after a
// single settle turn under load; poll bounded turns until the effect is visible.
async function flushUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('Timed out flushing mutation state');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useModelFavorites', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let createRoot: typeof createReactRoot;
  let useModelFavorites: typeof useModelFavoritesHook;
  let serverFavorites: string[];
  let currentApi: ReturnType<typeof useModelFavoritesHook> | undefined;

  function api() {
    if (!currentApi) throw new Error('Favorites hook was not rendered');
    return currentApi;
  }

  function Probe({ enabled = true }: { enabled?: boolean }) {
    currentApi = useModelFavorites({ enabled });
    return null;
  }

  async function renderProbe(props: { enabled?: boolean } = {}) {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe, props))
      );
    });
    await settle();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    serverFavorites = [...SERVER_FAVORITES];
    mockGet.mockImplementation(async () => ({
      favorites: [...serverFavorites],
      lastSelected: null,
    }));
    mockAdd.mockResolvedValue({ success: true });
    mockRemove.mockResolvedValue({ success: true });
    dom = installDom();
    ({ createRoot } = await import('react-dom/client'));
    ({ useModelFavorites } = await import('./use-model-preferences'));
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    });
    act(() => {
      root = createRoot(dom.container);
    });
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
      queryClient?.clear();
    } finally {
      dom?.cleanup();
    }
  });

  it('reads favorites org-less and keeps CLI-catalog remote keys', async () => {
    await renderProbe();
    expect(mockQueryOptions).toHaveBeenCalledWith(undefined);
    expect(api().favorites).toEqual(SERVER_FAVORITES);
  });

  it('adds optimistically while the request is pending, then refetches on success', async () => {
    await renderProbe();
    const add = deferred<{ success: boolean }>();
    mockAdd.mockReturnValueOnce(add.promise);

    await settle(() => api().addFavorite({ model: 'openai/gpt-5' }));
    await flushUntil(() => api().favorites.includes('openai/gpt-5'));
    expect(api().favorites).toEqual([...SERVER_FAVORITES, 'openai/gpt-5']);
    expect(mockGet).toHaveBeenCalledTimes(1);

    serverFavorites = [...SERVER_FAVORITES, 'openai/gpt-5'];
    add.resolve({ success: true });
    await flushUntil(() => mockGet.mock.calls.length >= 2);
    await flushUntil(() => api().favorites.length === serverFavorites.length);

    expect(api().favorites).toEqual(serverFavorites);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('rolls a failed add back to the server list and toasts, before the refetch lands', async () => {
    await renderProbe();
    const refetch = deferred<Preferences>();
    mockGet.mockReturnValueOnce(refetch.promise);
    mockAdd.mockRejectedValueOnce(new Error('favorites unavailable'));

    await settle(() => api().addFavorite({ model: 'openai/gpt-5' }));
    await flushUntil(() => mockToast.error.mock.calls.length > 0);

    expect(queryClient.getQueryData(GET_KEY)).toEqual({
      favorites: SERVER_FAVORITES,
      lastSelected: null,
    });
    expect(mockToast.error).toHaveBeenCalledWith('favorites unavailable');
    await flushUntil(() => api().favorites.length === SERVER_FAVORITES.length);
    expect(api().favorites).toEqual(SERVER_FAVORITES);

    refetch.resolve({ favorites: [...serverFavorites], lastSelected: null });
    await settle();
    expect(api().favorites).toEqual(SERVER_FAVORITES);
  });

  it('rolls a failed remove back to the server list and toasts', async () => {
    await renderProbe();
    const remove = deferred<{ success: boolean }>();
    mockRemove.mockReturnValueOnce(remove.promise);

    await settle(() => api().removeFavorite({ model: SERVER_FAVORITES[0] }));
    await flushUntil(() => api().favorites.length === 1);
    expect(api().favorites).toEqual([SERVER_FAVORITES[1]]);

    const refetch = deferred<Preferences>();
    mockGet.mockReturnValueOnce(refetch.promise);
    remove.reject(new Error('remove failed'));
    await flushUntil(() => mockToast.error.mock.calls.length > 0);

    expect(queryClient.getQueryData(GET_KEY)).toEqual({
      favorites: SERVER_FAVORITES,
      lastSelected: null,
    });
    expect(mockToast.error).toHaveBeenCalledWith('remove failed');
    await flushUntil(() => api().favorites.length === SERVER_FAVORITES.length);
    expect(api().favorites).toEqual(SERVER_FAVORITES);

    refetch.resolve({ favorites: [...serverFavorites], lastSelected: null });
    await settle();
    expect(api().favorites).toEqual(SERVER_FAVORITES);
  });

  it('serializes rapid taps and keeps a newer optimistic star when an earlier tap fails', async () => {
    await renderProbe();
    const addA = deferred<{ success: boolean }>();
    const addB = deferred<{ success: boolean }>();
    mockAdd.mockReturnValueOnce(addA.promise).mockReturnValueOnce(addB.promise);

    await settle(() => {
      api().addFavorite({ model: 'openai/gpt-5' });
      api().addFavorite({ model: 'openai/gpt-6' });
    });
    await flushUntil(() => api().favorites.length === SERVER_FAVORITES.length + 2);
    expect(api().favorites).toEqual([...SERVER_FAVORITES, 'openai/gpt-5', 'openai/gpt-6']);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd.mock.calls[0][0]).toEqual({ model: 'openai/gpt-5' });

    const refetch = deferred<Preferences>();
    mockGet.mockReturnValueOnce(refetch.promise);
    addA.reject(new Error('offline'));
    await flushUntil(() => mockToast.error.mock.calls.length > 0);

    expect(queryClient.getQueryData<{ favorites: string[] }>(GET_KEY)?.favorites).toEqual([
      ...SERVER_FAVORITES,
      'openai/gpt-5',
      'openai/gpt-6',
    ]);
    expect(mockToast.error).toHaveBeenCalledWith('offline');
    expect(mockAdd).toHaveBeenCalledTimes(1);

    refetch.resolve({ favorites: [...SERVER_FAVORITES], lastSelected: null });
    await flushUntil(() => mockAdd.mock.calls.length >= 2);
    expect(mockAdd.mock.calls[1][0]).toEqual({ model: 'openai/gpt-6' });

    serverFavorites = [...SERVER_FAVORITES, 'openai/gpt-6'];
    addB.resolve({ success: true });
    await flushUntil(() => mockGet.mock.calls.length >= 3);
    await flushUntil(() => api().favorites.length === serverFavorites.length);

    expect(api().favorites).toEqual(serverFavorites);
  });

  it('does not read when disabled and returns a stable empty list', async () => {
    await renderProbe({ enabled: false });
    expect(mockGet).not.toHaveBeenCalled();
    const first = api().favorites;
    expect(first).toEqual([]);

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { enabled: false })
        )
      );
    });
    expect(api().favorites).toBe(first);
  });
});
