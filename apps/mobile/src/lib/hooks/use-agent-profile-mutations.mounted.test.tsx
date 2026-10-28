import { type MobileRouter } from '@kilocode/trpc/mobile';
import { type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profile-mutations';
import { useAgentProfile, useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);

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
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const responses: Record<string, unknown> = {
  'agentProfiles.list': [],
  'agentProfiles.get': { id: 'profile-1', name: 'Backend' },
  'agentProfiles.delete': { success: true },
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input) === procedure).length;
}

type DeleteProfile = (input: { profileId: string }) => Promise<unknown>;

/** The profile Overview screen's queries: the list behind it, the detail, and its mutations. */
function ProfileOverviewProbe({ holder }: { holder: { current: DeleteProfile | null } }) {
  useAgentProfileList();
  useAgentProfile('profile-1');
  holder.current = useAgentProfileMutations().deleteProfile.mutateAsync;
  return null;
}

describe('useAgentProfileMutations deleteProfile', () => {
  beforeEach(() => {
    transport.mockReset().mockImplementation(async input => {
      await Promise.resolve();
      return Response.json({ result: { data: responses[procedureOf(input)] } });
    });
  });

  it('refetches the profile list but not the deleted profile while its screen is mounted', async () => {
    const queryClient = createTestQueryClient();
    const holder: { current: DeleteProfile | null } = { current: null };
    const { unmount } = await renderWithProviders(<ProfileOverviewProbe holder={holder} />, {
      queryClient,
      wrapper: ({ children }: { children: ReactNode }) => (
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      ),
    });
    await waitFor(() => callsTo('agentProfiles.get') === 1 && callsTo('agentProfiles.list') === 1);

    await act(async () => {
      await holder.current?.({ profileId: 'profile-1' });
    });

    await waitFor(() => callsTo('agentProfiles.list') === 2);
    expect(callsTo('agentProfiles.get')).toBe(1);
    unmount();
  });
});
