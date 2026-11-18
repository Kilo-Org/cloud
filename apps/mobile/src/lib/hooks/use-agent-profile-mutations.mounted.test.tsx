import { type MobileRouter } from '@kilocode/trpc/mobile';
import { type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profile-mutations';
import { useAgentProfileList, useAgentProfileVars } from '@/lib/hooks/use-agent-profiles';
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
  'agentProfiles.vars': [
    {
      key: 'API_BASE',
      value: 'http://localhost:3000',
      isSecret: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
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
  useAgentProfileVars('profile-1');
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
    await waitFor(() => callsTo('agentProfiles.vars') === 1 && callsTo('agentProfiles.list') === 1);

    await act(async () => {
      await holder.current?.({ profileId: 'profile-1' });
    });

    await waitFor(() => callsTo('agentProfiles.list') === 2);
    expect(callsTo('agentProfiles.vars')).toBe(1);
    unmount();
  });
});

type CreateProfile = (input: { name: string; description?: string }) => Promise<unknown>;

/** The composer's Save as Profile path: a write under the session's organization. */
function CreateProfileProbe({ holder }: { holder: { current: CreateProfile | null } }) {
  holder.current = useAgentProfileMutations('org-1').create.mutateAsync;
  return null;
}

// The refusal `ensureOrganizationAccess` throws for a role that cannot manage
// the organization's profiles.
const ROLE_DENIED = 'You do not have the required organizational role to access this feature';

/** A rejected organization profile write, as the tRPC client reports it. */
function deniedResponse(message = ROLE_DENIED) {
  return Response.json(
    {
      error: {
        message,
        code: -32_003,
        data: { code: 'UNAUTHORIZED', httpStatus: 401, path: 'agentProfiles.create' },
      },
    },
    { status: 401 }
  );
}

function mountCreateProbe(holder: { current: CreateProfile | null }) {
  const queryClient = createTestQueryClient();
  return renderWithProviders(<CreateProfileProbe holder={holder} />, {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });
}

describe('useAgentProfileMutations toast copy', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockReset();
    transport.mockReset();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('explains an organization-role refusal in the active language', async () => {
    transport.mockImplementation(async () => {
      await Promise.resolve();
      return deniedResponse();
    });
    await i18n.changeLanguage('pt-BR');

    const holder: { current: CreateProfile | null } = { current: null };
    const { unmount } = await mountCreateProbe(holder);
    await act(async () => {
      await holder.current?.({ name: 'Team setup' }).catch(() => undefined);
    });

    expect(callsTo('agentProfiles.create')).toBe(1);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Somente proprietários e administradores da organização podem alterar os perfis da organização.'
    );
    unmount();
  });

  it('relays any other rejection sentence unchanged', async () => {
    transport.mockImplementation(async () => {
      await Promise.resolve();
      return deniedResponse('Organization not found');
    });

    const holder: { current: CreateProfile | null } = { current: null };
    const { unmount } = await mountCreateProbe(holder);
    await act(async () => {
      await holder.current?.({ name: 'Team setup' }).catch(() => undefined);
    });

    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Organization not found');
    unmount();
  });
});
