import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as InfiniteRetentionModule from '@/lib/query/infinite-retention';

import { useOrgGroupMutations } from './use-org-groups-queries';

type MutationOptions = {
  onSuccess?: (result: unknown, vars: unknown) => void;
};

// `useOrgGroupMutations` registers its mutations in this order:
// create, updateDetails, remove.
const capturedMutations: MutationOptions[] = [];
const invalidateQueriesMock = vi.fn(() => Promise.resolve());
const reconcileFirstPageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// One object for every `useQueryClient` call, so an assertion can name the
// client the hook handed the reconcile.
const queryClientMock = { invalidateQueries: invalidateQueriesMock };

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedMutations.push(opts);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => queryClientMock,
}));

// The real module stays loaded (its probe never runs here); only the reconcile
// is replaced, so it records the call instead of touching a query cache this
// suite never builds.
vi.mock('@/lib/query/infinite-retention', async importOriginal => {
  const actual = await importOriginal<typeof InfiniteRetentionModule>();
  return { ...actual, reconcileFirstPage: reconcileFirstPageMock };
});

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      groups: {
        pathFilter: () => ({ queryKey: ['organizations', 'groups'] }),
      },
    },
  }),
  trpcClient: {
    organizations: {
      groups: {
        create: { mutate: vi.fn() },
        updateDetails: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
    },
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function groupMutation(index: number): MutationOptions {
  const mutation = capturedMutations[index];
  if (!mutation) {
    throw new Error(`useOrgGroupMutations registered no mutation at index ${index}`);
  }
  return mutation;
}

describe('useOrgGroupMutations audit log refresh', () => {
  beforeEach(() => {
    capturedMutations.length = 0;
    invalidateQueriesMock.mockClear();
    reconcileFirstPageMock.mockClear();
  });

  it('create refreshes the audit log page one beside the groups invalidation', () => {
    useOrgGroupMutations(ORG_ID);
    groupMutation(0).onSuccess?.({}, {});

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClientMock, [
      'organizations.auditLogs.list',
      ORG_ID,
    ]);
    // The invalidation this hook already made stays exactly as it was.
    expect(invalidateQueriesMock).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['organizations', 'groups'],
    });
  });

  it('updateDetails shares the same refresh', () => {
    useOrgGroupMutations(ORG_ID);
    groupMutation(1).onSuccess?.({}, {});

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClientMock, [
      'organizations.auditLogs.list',
      ORG_ID,
    ]);
    expect(invalidateQueriesMock).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['organizations', 'groups'],
    });
  });

  it('remove shares the same refresh', () => {
    useOrgGroupMutations(ORG_ID);
    groupMutation(2).onSuccess?.({}, {});

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClientMock, [
      'organizations.auditLogs.list',
      ORG_ID,
    ]);
    expect(invalidateQueriesMock).toHaveBeenCalledExactlyOnceWith({
      queryKey: ['organizations', 'groups'],
    });
  });
});
