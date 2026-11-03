import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ModelOption,
  useAvailableModels,
  useOrgDefaultModel,
} from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

type ModelPreferences = inferRouterOutputs<MobileRouter>['modelPreferences']['get'];

const world = vi.hoisted(() => ({
  catalog: 'ok' as 'ok' | 'unreachable' | 'server-error',
  requests: [] as string[],
  procedures: [] as string[],
}));

// `vi.mock` factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [
        httpLink({
          url: 'https://api.example.com/api/trpc',
          fetch: async input => {
            await Promise.resolve();
            const url = new URL(input instanceof Request ? input.url : input.toString());
            world.procedures.push(url.pathname.replace('/api/trpc/', ''));
            return Response.json({
              result: { data: { favorites: ['a/model'], lastSelected: { model: 'a/model' } } },
            });
          },
        }),
      ],
    }),
  };
});
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: () => Promise.resolve('token'),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/** How many requests the stubbed transport saw for a URL fragment. */
function matching(fragment: string): number {
  return world.requests.filter(url => url.includes(fragment)).length;
}

type CatalogSnapshot = {
  models: ModelOption[];
  isLoading: boolean;
  isError: boolean;
  isFetched: boolean;
  refetch: () => unknown;
};

type OrgDefaultSnapshot = { defaultModel: string | undefined; isLoading: boolean };

type PreferencesSnapshot = {
  favorites: string[];
  lastSelected: ModelPreferences['lastSelected'];
  isLoading: boolean;
};

const catalogRead: { current: CatalogSnapshot | null } = { current: null };
const orgDefaultRead: { current: OrgDefaultSnapshot | null } = { current: null };
const preferencesRead: { current: PreferencesSnapshot | null } = { current: null };

function CatalogProbe() {
  const { models, isLoading, isError, isFetched, refetch } = useAvailableModels(undefined);
  catalogRead.current = { models, isLoading, isError, isFetched, refetch };
  return null;
}

function OrgDefaultProbe() {
  const { defaultModel, isLoading } = useOrgDefaultModel('org_1');
  orgDefaultRead.current = { defaultModel, isLoading };
  return null;
}

function PreferencesProbe() {
  const { favorites, lastSelected, isLoading } = useModelPreferences(undefined);
  preferencesRead.current = { favorites, lastSelected, isLoading };
  return null;
}

const queryClientRef: { current: QueryClient | null } = { current: null };

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = queryClientRef.current;
  if (!queryClient) {
    throw new Error('wrapper rendered before the test client was installed');
  }
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </TRPCProvider>
  );
}

function newClient(): QueryClient {
  const queryClient = new QueryClient({
    // Each hook's own `staleTime` is what a reconnect must not wait out, so the
    // client default mirrors the app's freshness window instead of Infinity.
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 60_000 } },
  });
  queryClientRef.current = queryClient;
  return queryClient;
}

describe('model catalogue reads while the online manager reports offline', () => {
  beforeEach(() => {
    world.catalog = 'ok';
    world.requests.length = 0;
    world.procedures.length = 0;
    catalogRead.current = null;
    orgDefaultRead.current = null;
    preferencesRead.current = null;
    queryClientRef.current = null;
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      world.requests.push(url);
      if (world.catalog === 'unreachable') {
        return Promise.reject(new TypeError('Network request failed'));
      }
      if (world.catalog === 'server-error') {
        return Promise.resolve(
          new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
        );
      }
      if (url.includes('/api/organizations/')) {
        return Promise.resolve(Response.json({ defaultModel: 'org/default' }));
      }
      return Promise.resolve(
        Response.json({ data: [{ id: 'a/model', name: 'Display: A Model' }] })
      );
    });
    // A test that simulates the app reporting offline must not leak that state.
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
  });

  it('requests and settles the catalogue while the manager reports offline', async () => {
    // NetInfo can hold the device offline while the backend is reachable. A read
    // that keeps the default online-only mode pauses before its first byte: the
    // request never starts, `isLoading` is false and no failure ever surfaces.
    const queryClient = newClient();
    onlineManager.setOnline(false);

    const { unmount } = await renderWithProviders(<CatalogProbe />, { queryClient, wrapper });

    await waitFor(() => catalogRead.current?.isFetched === true);
    expect(matching('/api/openrouter/models')).toBe(1);
    expect(catalogRead.current?.isLoading).toBe(false);
    expect(catalogRead.current?.isError).toBe(false);
    expect(catalogRead.current?.models.map(model => model.id)).toEqual(['a/model']);
    unmount();
  });

  it('settles a failed catalogue read into its error state and lets the retry issue a request', async () => {
    world.catalog = 'unreachable';
    const queryClient = newClient();
    onlineManager.setOnline(false);

    const { unmount } = await renderWithProviders(<CatalogProbe />, { queryClient, wrapper });

    await waitFor(() => catalogRead.current?.isError === true);
    expect(catalogRead.current?.isLoading).toBe(false);
    expect(catalogRead.current?.models).toEqual([]);
    expect(matching('/api/openrouter/models')).toBe(1);

    // The composer's "couldn't load models" Retry calls `refetch`; a paused read
    // would re-pause here instead of asking the backend again.
    await act(() => {
      void catalogRead.current?.refetch();
    });
    await waitFor(() => matching('/api/openrouter/models') === 2);
    unmount();
  });

  it('retries an offline failure when connectivity returns', async () => {
    world.catalog = 'unreachable';
    const queryClient = newClient();
    onlineManager.setOnline(false);

    const { unmount } = await renderWithProviders(<CatalogProbe />, { queryClient, wrapper });
    await waitFor(() => catalogRead.current?.isFetched === true);
    expect(catalogRead.current?.isError).toBe(true);
    expect(matching('/api/openrouter/models')).toBe(1);

    // `refetchOnReconnect: true` recovers the failed read on the online edge; the
    // query is stale exactly there, so the retry does not wait for the next mount.
    world.catalog = 'ok';
    await act(() => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => matching('/api/openrouter/models') === 2);
    await waitFor(() => catalogRead.current?.isError === false);
    unmount();
  });

  it('requests and settles the org default while the manager reports offline', async () => {
    const queryClient = newClient();
    onlineManager.setOnline(false);

    const { unmount } = await renderWithProviders(<OrgDefaultProbe />, { queryClient, wrapper });

    await waitFor(() => orgDefaultRead.current?.defaultModel === 'org/default');
    expect(matching('/api/organizations/org_1/defaults')).toBe(1);
    expect(orgDefaultRead.current?.isLoading).toBe(false);
    unmount();
  });

  it('requests and settles the server model preference while the manager reports offline', async () => {
    const queryClient = newClient();
    onlineManager.setOnline(false);

    const { unmount } = await renderWithProviders(<PreferencesProbe />, { queryClient, wrapper });

    await waitFor(() => preferencesRead.current?.favorites.length === 1);
    expect(world.procedures).toEqual(['modelPreferences.get']);
    expect(preferencesRead.current?.isLoading).toBe(false);
    expect(preferencesRead.current?.lastSelected).toEqual({ model: 'a/model' });
    unmount();
  });
});
