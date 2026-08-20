import { describe, expect, it, vi } from 'vitest';

import { buildPrInboxQueryOptions } from './use-pr-inbox';

// `use-pr-inbox` imports `useTRPC` from `@/lib/trpc`, which pulls the whole
// expo auth/token module graph. Mock it so the module loads under Node.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
}));

type Trpc = Parameters<typeof buildPrInboxQueryOptions>[0];

type InboxPage = { items: unknown[]; nextCursor: string | null };

type LooseOptions = {
  enabled?: boolean;
  staleTime?: number;
  maxPages?: number;
  getNextPageParam?: (lastPage: InboxPage) => string | undefined;
};

function makeTrpc() {
  const infiniteQueryOptions = vi.fn((input: unknown, opts: Record<string, unknown>) => ({
    input,
    ...opts,
  }));
  return {
    githubPrReview: {
      listInbox: { infiniteQueryOptions },
    },
  } as unknown as Trpc;
}

function build(enabled: boolean): LooseOptions {
  return buildPrInboxQueryOptions(makeTrpc(), enabled) as unknown as LooseOptions;
}

describe('buildPrInboxQueryOptions', () => {
  it('forwards enabled and sets a 30s staleTime', () => {
    const opts = build(true);
    expect(opts.enabled).toBe(true);
    expect(opts.staleTime).toBe(30_000);
  });

  it('forwards a disabled flag', () => {
    const opts = build(false);
    expect(opts.enabled).toBe(false);
  });

  it('returns the cursor for a page with a nextCursor', () => {
    expect(build(true).getNextPageParam?.({ items: [], nextCursor: 'abc' })).toBe('abc');
  });

  it('returns undefined for a page with nextCursor null', () => {
    expect(build(true).getNextPageParam?.({ items: [], nextCursor: null })).toBeUndefined();
  });

  it('caps the inbox at 20 pages', () => {
    expect(build(true).maxPages).toBe(20);
  });
});
