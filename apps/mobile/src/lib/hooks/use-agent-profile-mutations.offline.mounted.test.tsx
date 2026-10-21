import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentProfile, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

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
  'agentProfiles.list': [],
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
  'agentProfiles.update': { success: true },
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input) === procedure).length;
}

type UpdateProfile = (input: { profileId: string; name: string }) => Promise<unknown>;

/** The overview screen's detail query plus the metadata save mutation. */
function ProfileSaveProbe({ holder }: { holder: { current: UpdateProfile | null } }) {
  useAgentProfile('profile-1');
  holder.current = useAgentProfileMutations().update.mutateAsync;
  return null;
}

const queryClientRef: { current: ReturnType<typeof createTestQueryClient> | null } = {
  current: null,
};

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

describe('offline profile save', () => {
  beforeEach(() => {
    connectivity.value = 'online';
    queryClientRef.current = null;
    transport.mockReset();
    onlineManager.setOnline(true);
  });

  it('settles the save while the online manager is offline, so isPending cannot stick', async () => {
    transport.mockImplementation(async input => {
      await Promise.resolve();
      return Response.json({ result: { data: responses[procedureOf(input)] } });
    });
    const queryClient = createTestQueryClient();
    queryClientRef.current = queryClient;
    // The lifecycle drives this from NetInfo; simulate a committed-offline
    // manager, which pauses default `networkMode: 'online'` mutations forever.
    onlineManager.setOnline(false);

    const holder: { current: UpdateProfile | null } = { current: null };
    const { unmount } = await renderWithProviders(<ProfileSaveProbe holder={holder} />, {
      queryClient,
      wrapper,
    });
    await waitFor(() => callsTo('agentProfiles.get') === 1);

    await act(async () => {
      await holder.current?.({ profileId: 'profile-1', name: 'Backend' });
    });

    // With `networkMode: 'always'` the save reached the transport despite the
    // offline manager, so the mutation settled and `isPending` returned false.
    expect(callsTo('agentProfiles.update')).toBe(1);
    unmount();
  });
});
