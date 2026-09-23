import { describe, expect, it, vi } from 'vitest';

import {
  buildOrgCreditTransactionsPageQueryOptions,
  buildOrgInvoicesPageQueryOptions,
} from '@/lib/hooks/use-organization-queries';
import { INFINITE_QUERY_MAX_PAGES } from '@/lib/query/infinite-retention';

// The hook module imports its context providers (and the real tRPC client)
// transitively; the options builders are pure, so only the module-load chain
// needs these mocks. No hook is mounted.
vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: vi.fn() }));

type Page = { hasMore: boolean; nextCursor: string | null };

const echoInfiniteQueryOptions = (input: unknown, options: object) => ({ ...options, input });

type EchoedOptions = {
  maxPages: number;
  enabled: boolean;
  input: { organizationId: string; period?: string };
  getNextPageParam: (lastPage: Page) => string | undefined;
};

/**
 * Fake tRPC router whose `infiniteQueryOptions` echoes the options it was
 * given alongside the input, so a builder's retention bound and the exact
 * input each procedure receives can be asserted without mounting the hook.
 */
function createTrpcStub() {
  const stub = {
    organizations: {
      creditTransactionsPage: { infiniteQueryOptions: echoInfiniteQueryOptions },
      invoicesPage: { infiniteQueryOptions: echoInfiniteQueryOptions },
    },
  };
  return stub as never;
}

function readOptions(options: object): EchoedOptions {
  return options as unknown as EchoedOptions;
}

describe('buildOrgCreditTransactionsPageQueryOptions', () => {
  it('applies the shared retention bound', () => {
    const options = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(options.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
  });

  it('keeps the enabled passthrough (disabled for a null organizationId)', () => {
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')).enabled
    ).toBe(true);
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), null)).enabled
    ).toBe(false);
  });

  it('passes the organizationId through to the procedure input', () => {
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')).input
    ).toEqual({ organizationId: 'org-1' });
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), null)).input
    ).toEqual({ organizationId: '' });
  });

  it('returns the next cursor while hasMore, and stops on the last page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(getNextPageParam({ hasMore: true, nextCursor: 'cursor-1' })).toBe('cursor-1');
    expect(getNextPageParam({ hasMore: false, nextCursor: 'cursor-2' })).toBeUndefined();
    expect(getNextPageParam({ hasMore: true, nextCursor: null })).toBeUndefined();
  });
});

describe('buildOrgInvoicesPageQueryOptions', () => {
  it('applies the shared retention bound', () => {
    const options = readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1'));

    expect(options.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
  });

  it('keeps the enabled passthrough (disabled for a null organizationId)', () => {
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')).enabled).toBe(
      true
    );
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), null)).enabled).toBe(
      false
    );
  });

  it("keeps the fixed period: 'year' input and the organizationId", () => {
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')).input).toEqual({
      organizationId: 'org-1',
      period: 'year',
    });
  });

  it('returns the next cursor while hasMore, and stops on the last page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(getNextPageParam({ hasMore: true, nextCursor: 'cursor-1' })).toBe('cursor-1');
    expect(getNextPageParam({ hasMore: false, nextCursor: 'cursor-2' })).toBeUndefined();
    expect(getNextPageParam({ hasMore: true, nextCursor: null })).toBeUndefined();
  });
});
