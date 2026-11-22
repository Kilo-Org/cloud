import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { type QueryClient } from '@tanstack/react-query';
import { type ReactElement, type ReactNode } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useSecurityScopeTitle } from '@/lib/hooks/use-security-scope-title';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const authState = vi.hoisted(() => ({ token: undefined as string | undefined }));

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://scope-title.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => authState }));
// The assertions read on keys, so the copy layer answers each key with itself.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const SCOPE = 'org-1';

const MEMBERSHIPS = [{ organizationId: SCOPE, organizationName: 'Org One', role: 'owner' }];

/** The key tRPC's proxy builds for `organizations.list`: the path, the type, no input. */
const ORGANIZATIONS_KEY = [['organizations', 'list'], { type: 'query' }];

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

/** The title of the latest render, which is what the header would paint. */
type TitleHolder = { title: string | null };

/** Registers the shared list observer first, so the title observer registers over it. */
function SharedListProbe() {
  useOrganizationsList();
  return null;
}

function TitleProbe({ scope, holder }: { scope: string; holder: TitleHolder }) {
  holder.title = useSecurityScopeTitle(scope);
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

async function mount(ui: (holder: TitleHolder) => ReactElement) {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: TitleHolder = { title: null };
  const view = await renderWithProviders(ui(holder), { queryClient, wrapper });
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

describe('security scope title', () => {
  beforeEach(() => {
    queryClientRef.current = null;
    transport.mockReset();
    transport.mockResolvedValue(Response.json({ result: { data: MEMBERSHIPS } }));
    authState.token = 'tok';
  });

  afterEach(() => {
    authState.token = undefined;
  });

  it('keeps the shared list entry settling while offline after the title observer registers', async () => {
    // One cache entry owns one option set, and the last observer to register
    // wins. A title observer built with defaulted options reverts the entry's
    // settle-while-offline settings, so every other consumer of the list stalls
    // in `pending` on a device the online manager calls offline.
    const { view, queryClient } = await mount(title => (
      <>
        <SharedListProbe />
        <TitleProbe scope={SCOPE} holder={title} />
      </>
    ));

    const entry = queryClient.getQueryCache().find({ queryKey: ORGANIZATIONS_KEY, exact: true });
    expect(entry).toBeDefined();
    expect(entry?.options.networkMode).toBe('always');
    // `refetchOnReconnect` is an observer option the query's defaulted options
    // carry; the query's own `options` type does not declare it.
    expect(entry?.options).toMatchObject({ refetchOnReconnect: true });
    view.unmount();
  });

  it('never reads the memberships for the title', async () => {
    // The scope's own capability read or the app-wide prefetch owns this
    // request. A read started here joins the query's pause and resume path, so an
    // offline retry waits on the title instead of the reads it was retrying.
    const { view, holder } = await mount(title => <TitleProbe scope={SCOPE} holder={title} />);
    await flush();

    expect(callsTo('organizations.list')).toBe(0);
    expect(holder.title).toBe('common.organization');
    view.unmount();
  });

  it('names the organization from the shared entry, and the personal scope from copy', async () => {
    const organization = await mount(title => <TitleProbe scope={SCOPE} holder={title} />);

    // Seeded after the mount, so the case reads the observer's answer to a list
    // another surface already loaded.
    act(() => {
      organization.queryClient.setQueryData(ORGANIZATIONS_KEY, MEMBERSHIPS);
    });
    await waitFor(() => organization.holder.title === 'Org One');
    organization.view.unmount();

    const personal = await mount(title => (
      <TitleProbe scope={PERSONAL_SECURITY_SCOPE} holder={title} />
    ));
    expect(personal.holder.title).toBe('common.personal');
    personal.view.unmount();
  });
});
