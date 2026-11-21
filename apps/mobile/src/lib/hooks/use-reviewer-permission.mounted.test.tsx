import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { type ComponentType, type ReactNode } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PermissionState } from '@/lib/code-reviewer-status';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { useReviewerPermission } from '@/lib/hooks/use-reviewer-permission';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
// The auth mock reads this object at render time, so a case can mount before or
// after the token resolves.
const authState = vi.hoisted(() => ({ token: undefined as string | undefined }));

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://reviewer.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => authState }));
// The permission read reaches the edit guard's router, and expo-router is the
// native runtime this node environment cannot load.
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const SCOPE = 'org-1';

let membershipRole = 'owner';

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

function respondWithMembership() {
  transport.mockImplementation(async input => {
    await Promise.resolve();
    const procedure = procedureOf(input);
    if (procedure !== 'organizations.list') {
      throw new Error(`read not provided by this suite: ${procedure}`);
    }
    return Response.json({
      result: {
        data: [{ organizationId: SCOPE, organizationName: 'Org One', role: membershipRole }],
      },
    });
  });
}

/** The classified state of the latest render, which is what a screen would paint. */
type Holder = { state: PermissionState | null };

type ProbeProps = { holder: Holder };

function PermissionProbe({ holder }: ProbeProps) {
  holder.state = useReviewerPermission(SCOPE);
  return null;
}

/** The personal scope's own probe, so the case reads the gate rather than the org role. */
function PersonalScopeProbe({ holder }: ProbeProps) {
  holder.state = useReviewerPermission(PERSONAL_SCOPE);
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

async function mountPermission(Probe: ComponentType<ProbeProps>) {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Holder = { state: null };
  const view = await renderWithProviders(<Probe holder={holder} />, { queryClient, wrapper });
  return { view, queryClient, holder };
}

/** One macrotask: long enough for a scheduled fetch to reach the transport. */
async function flush() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  await act(async () => {
    setTimeout(() => {
      resolve(undefined);
    }, 0);
    await promise;
  });
}

describe('code reviewer permission read', () => {
  beforeEach(() => {
    queryClientRef.current = null;
    transport.mockReset();
    authState.token = undefined;
    membershipRole = 'owner';
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('does not read the memberships before the token resolves', async () => {
    // The nested reviewer routes are reachable by URL, so a deep link can mount
    // this hook before sign-in restores the token. A read started from here goes
    // out unauthenticated, fails, and the guard then treats the failure as "not
    // an editor" — bouncing a real owner off the screen they linked to.
    respondWithMembership();
    const { view, holder } = await mountPermission(PermissionProbe);
    await flush();

    expect(callsTo('organizations.list')).toBe(0);
    expect(holder.state).toEqual({ status: 'loading' });
    view.unmount();
  });

  it('settles the role while the online manager reports offline', async () => {
    // NetInfo can hold the device offline while the backend is reachable. A read
    // on the default online-only mode pauses before its first byte: no request,
    // no error, and the role never resolves, so an owner sees a screen with
    // neither the editor's controls nor the read-only refusal.
    authState.token = 'tok';
    onlineManager.setOnline(false);
    respondWithMembership();
    const { view, queryClient, holder } = await mountPermission(PermissionProbe);

    await waitFor(() => holder.state?.status === 'ready');
    expect(callsTo('organizations.list')).toBe(1);
    expect(holder.state).toEqual({ status: 'ready', canEdit: true, canManage: true });

    // `canEdit` (billing roles included) and `canManage` (owners and admins) are
    // separate capabilities, and a plain member holds neither: reading one
    // role's answer twice would offer a member the install and save actions.
    membershipRole = 'member';
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() => holder.state?.status === 'ready' && !holder.state.canEdit);
    expect(holder.state).toEqual({ status: 'ready', canEdit: false, canManage: false });
    view.unmount();
  });

  it('keeps the personal scope ready without a memberships read', async () => {
    // A personal scope's capabilities are its own account's, so a memberships
    // read there answers nothing: it would only delay the personal editor behind
    // a request the screen never reads.
    authState.token = 'tok';
    respondWithMembership();
    const { view, holder } = await mountPermission(PersonalScopeProbe);
    await flush();

    expect(callsTo('organizations.list')).toBe(0);
    expect(holder.state).toEqual({ status: 'ready', canEdit: true, canManage: true });
    view.unmount();
  });
});
