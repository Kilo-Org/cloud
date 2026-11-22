import { type MobileRouter } from '@kilocode/trpc/mobile';
import { type QueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type CouncilGate, useCouncilGate } from '@/lib/hooks/use-reviewer-council';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

// The council gate decides which of three refusals an organization reader sees.
// Two of its answers are the surface's own state rather than the entitlement's:
// a read that has never settled keeps the surface blank, and a read that failed
// offers a Retry. The Retry re-runs the same read, and a query that re-runs
// reports itself pending again until an answer lands, so the two must stay
// distinguishable or pressing Retry erases the refusal that offered it.

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
// The flag read comes from the analytics module, which reaches the Expo runtime
// this node environment cannot load; the gate only needs its answer.
const flagState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/lib/trpc', async () => {
  // `vi.mock` factories run before this file's imports, so the client modules
  // cannot be static imports here; the sibling permission suite does the same.
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://council.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/analytics/posthog', () => ({ useFeatureFlag: () => flagState.enabled }));
// The gate reaches the reviewer helpers (for the personal-scope test) and that
// module pulls the whole reviewer screen graph, including React Native's Flow
// source this node environment cannot parse. Only the one predicate is needed.
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const SCOPE = 'org-1';
const ENTITLEMENT = 'organizations.reviewAgent.getCouncilEntitlement';

type Holder = { gate: CouncilGate | null };

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

function CouncilProbe({ holder }: { holder: Holder }) {
  holder.gate = useCouncilGate(SCOPE);
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

async function mountCouncil() {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Holder = { gate: null };
  const view = await renderWithProviders(<CouncilProbe holder={holder} />, { queryClient, wrapper });
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

/** An answer the test controls, so a case can hold a read open or fail it. */
function deferredAnswer() {
  const { promise, resolve } = Promise.withResolvers<Response>();
  return { promise, resolve };
}

describe('council gate', () => {
  beforeEach(() => {
    queryClientRef.current = null;
    transport.mockReset();
    flagState.enabled = true;
  });

  it('holds the surface blank only until the first answer settles', async () => {
    const answer = deferredAnswer();
    transport.mockImplementation(async () => answer.promise);

    const { view, holder } = await mountCouncil();
    await flush();

    expect(holder.gate?.pending).toBe(true);
    answer.resolve(Response.json({ result: { data: { entitled: true } } }));
    await waitFor(() => holder.gate?.pending === false);

    expect(holder.gate?.allowed).toBe(true);
    view.unmount();
  });

  it('keeps the failed refusal, and reports the retry busy, while that retry re-reads', async () => {
    // The first answer fails, so the reader is offered the Retry. A re-running
    // query reports `status: 'pending'` again, which is also what a first read
    // reports: if the gate read them alike, pressing Retry would replace the
    // refusal with the blank surface and the reader would lose the button.
    let attempt = 0;
    const retryAnswer = deferredAnswer();
    transport.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return Response.json(
          { error: { message: 'Internal server error', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR' } } },
          { status: 500 }
        );
      }
      return retryAnswer.promise;
    });

    const { view, holder } = await mountCouncil();
    await flush();

    expect(holder.gate?.refusalReason).toBe('entitlementErrored');
    expect(holder.gate?.pending).toBe(false);

    act(() => {
      holder.gate?.retryEntitlement();
    });
    await flush();

    // The retry is in flight: the refusal must still own the surface, and the
    // action must report its own wait.
    expect(callsTo(ENTITLEMENT)).toBe(2);
    expect(holder.gate?.refusalReason).toBe('entitlementErrored');
    expect(holder.gate?.pending).toBe(false);
    expect(holder.gate?.entitlementFetching).toBe(true);

    retryAnswer.resolve(Response.json({ result: { data: { entitled: false } } }));
    await waitFor(() => holder.gate?.entitlementFetching === false);

    expect(holder.gate?.refusalReason).toBe('refused');
    view.unmount();
  });
});
