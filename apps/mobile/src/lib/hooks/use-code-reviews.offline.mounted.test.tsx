/**
 * A manual review create tapped while the device reports itself offline.
 *
 * The cloud-create screen guards its Back press on this mutation's `isPending`.
 * On React Query's default `networkMode: 'online'` the create pauses for as long
 * as the online manager reports offline: no request leaves, nothing settles, and
 * the leave guard keeps swallowing Back. The hook asks for
 * `MUTATE_WHILE_OFFLINE`, so the attempt is made and its rejection settles the
 * mutation through `onError` — the same state the guard reads.
 *
 * Mounted with a real `QueryClient` and the real `onlineManager`; only the tRPC
 * transport is replaced, so the pause (or its absence) is React Query's own.
 */

import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked below; the mock supplies both exports.
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import '@/i18n';
import { useCreateManualReview } from './use-code-reviews';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);

const toastError = vi.hoisted(() => vi.fn());

// vi.mock factories are hoisted above static imports, so they import lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://reviews.test/api/trpc', fetch: transport })],
    }),
  };
});

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: (message: string) => toastError(message) },
}));

vi.mock('./use-code-reviewer', () => ({ PERSONAL_SCOPE: 'personal' }));

type RouterInputs = inferRouterInputs<MobileRouter>;
type CreateManualReviewInput = RouterInputs['personalReviewAgent']['createManualReviewJob'];

const CREATE_VARS: CreateManualReviewInput = {
  platform: 'github',
  url: 'https://github.com/foo/bar/pull/1',
  modelSlug: 'claude-opus-4-7',
};

/** The slice of the mutation result this suite reads, which is what the guard reads. */
type CreateReviewState = {
  mutate: (vars: CreateManualReviewInput) => void;
  status: 'idle' | 'pending' | 'error' | 'success';
  isPending: boolean;
  isError: boolean;
  error: Error | null;
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace('/api/trpc/', '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input) === procedure).length;
}

function CreateReviewProbe({ holder }: { holder: { current: CreateReviewState | null } }) {
  holder.current = useCreateManualReview('personal');
  return null;
}

describe('useCreateManualReview while the online manager reports offline', () => {
  beforeEach(() => {
    toastError.mockReset();
    transport.mockReset();
  });

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('sends the create and settles it instead of pausing in pending', async () => {
    onlineManager.setOnline(false);
    // The request cannot reach the server: what a paused mutation never
    // discovers, because it sends nothing at all.
    transport.mockImplementation(async () => {
      await Promise.resolve();
      throw new TypeError('Network request failed');
    });

    const holder: { current: CreateReviewState | null } = { current: null };
    const queryClient = createTestQueryClient();
    const { unmount } = await renderWithProviders(<CreateReviewProbe holder={holder} />, {
      queryClient,
      wrapper: ({ children }: { children: ReactNode }) => (
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      ),
    });

    act(() => {
      holder.current?.mutate(CREATE_VARS);
    });

    // A paused mutation never reaches this point: it stays `pending` until the
    // online manager flips, so the assertion is that this one settled.
    await waitFor(() => holder.current?.status === 'error');

    expect(callsTo('personalReviewAgent.createManualReviewJob')).toBe(1);
    expect(holder.current?.isPending).toBe(false);
    expect(holder.current?.isError).toBe(true);
    expect(holder.current?.error?.message).toBe('Network request failed');
    // The hook's own failure path ran: the screen hears the rejection.
    expect(toastError).toHaveBeenCalledTimes(1);
    unmount();
  });
});
