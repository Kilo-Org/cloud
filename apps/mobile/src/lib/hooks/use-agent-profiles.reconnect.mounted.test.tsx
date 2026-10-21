import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentProfile } from '@/lib/hooks/use-agent-profiles';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() => vi.fn<typeof fetch>());
const connectivity = vi.hoisted(() => ({ value: 'online' as string }));

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://profiles.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
  useOfflineBannerState: () => connectivity.value === 'offline',
  useCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const responses: Record<string, unknown> = {
  'agentProfiles.get': {
    id: 'profile-1',
    name: 'Backend',
    description: null,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    vars: [],
    commands: [],
    mcpServers: [],
    skills: [],
    agents: [],
    kiloCommands: [],
    instructions: [],
  },
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input) === procedure).length;
}

/** The overview screen's detail read, with nothing else mounted. */
function ProfileDetailProbe() {
  useAgentProfile('profile-1');
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

describe('profile read reconnect recovery', () => {
  beforeEach(() => {
    connectivity.value = 'online';
    queryClientRef.current = null;
    transport.mockReset();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('refetches a fresh profile read when connectivity returns', async () => {
    transport.mockImplementation(async input => {
      await Promise.resolve();
      return Response.json({ result: { data: responses[procedureOf(input)] } });
    });
    // `networkMode: 'always'` makes connected reads settle offline but also
    // flips the derived `refetchOnReconnect` default to false. A fresh read
    // inside the app's 30 s freshness window stands in for the connectivity
    // blip a user meets: recovery must not wait for the data to go stale.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } },
    });
    queryClientRef.current = queryClient;

    const { unmount } = await renderWithProviders(<ProfileDetailProbe />, {
      queryClient,
      wrapper,
    });
    await waitFor(() => callsTo('agentProfiles.get') === 1);
    // Let the first read settle, so the reconnect refetch below is the only
    // reason for a second request.
    await waitFor(() =>
      queryClient
        .getQueryCache()
        .getAll()
        .every(query => query.state.status === 'success' && !query.isStale())
    );

    await act(() => {
      onlineManager.setOnline(false);
    });
    expect(callsTo('agentProfiles.get')).toBe(1);

    await act(() => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => callsTo('agentProfiles.get') === 2);
    unmount();
  });
});
