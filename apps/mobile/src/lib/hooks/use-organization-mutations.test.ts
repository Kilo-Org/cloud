/* eslint-disable require-await, @typescript-eslint/require-await -- the second mutationFn resolves immediately without awaiting */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ReactQuery from '@tanstack/react-query';

import { useOrganizationMutations } from './use-organization-mutations';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars: unknown, context: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  scope?: { id: string };
};

// useOrganizationMutations registers its mutations in this order:
// rename, invite, updateMember, removeMember, deleteInvite, updateMinimumBalanceAlert.
const capturedMutations: (MutationOptions | null)[] = [];
const invalidateQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const cancelQueriesMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedMutations.push(opts);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
    getQueryData: (...args: unknown[]) => getQueryDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string) => toastErrorMock(msg),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      withMembers: {
        queryKey: ({ organizationId }: { organizationId: string }) => [
          'organizations',
          'withMembers',
          { organizationId },
        ],
      },
      list: { queryKey: () => ['organizations', 'list'] },
    },
  }),
  trpcClient: {
    organizations: {
      update: { mutate: vi.fn() },
      members: {
        invite: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        remove: { mutate: vi.fn() },
        deleteInvite: { mutate: vi.fn() },
      },
      settings: {
        updateMinimumBalanceAlert: { mutate: vi.fn() },
      },
    },
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('useOrganizationMutations (generation guard + scope)', () => {
  beforeEach(() => {
    capturedMutations.length = 0;
    invalidateQueriesMock.mockReset();
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scopes all five optimistic mutations and leaves invite unscoped', () => {
    useOrganizationMutations(ORG_ID);
    const expectedScope = { id: `organization:${ORG_ID}` };
    // rename
    expect(capturedMutations[0]?.scope).toEqual(expectedScope);
    // invite
    expect(capturedMutations[1]?.scope).toBeUndefined();
    // updateMember
    expect(capturedMutations[2]?.scope).toEqual(expectedScope);
    // removeMember
    expect(capturedMutations[3]?.scope).toEqual(expectedScope);
    // deleteInvite
    expect(capturedMutations[4]?.scope).toEqual(expectedScope);
    // updateMinimumBalanceAlert
    expect(capturedMutations[5]?.scope).toEqual(expectedScope);
  });

  it('a failing older updateMember does not roll back while a newer one owns the cache', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    useOrganizationMutations(ORG_ID);
    const updateMember = capturedMutations[2];
    const older = await updateMember?.onMutate?.({ memberId: 'm1', role: 'admin' });
    const newer = await updateMember?.onMutate?.({ memberId: 'm2', role: 'member' });

    setQueryDataMock.mockClear();
    updateMember?.onError?.(new Error('boom'), { memberId: 'm1', role: 'admin' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    updateMember?.onError?.(new Error('boom'), { memberId: 'm2', role: 'member' }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    // updateMember toasts by default (not silent).
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest updateMember rolls back its snapshot', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    useOrganizationMutations(ORG_ID);
    const updateMember = capturedMutations[2];
    const context = await updateMember?.onMutate?.({ memberId: 'm1', role: 'admin' });

    setQueryDataMock.mockClear();
    updateMember?.onError?.(new Error('boom'), { memberId: 'm1', role: 'admin' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('updateMember stays inline (no toast) when silenceUpdateMemberToast is set', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    useOrganizationMutations(ORG_ID, { silenceUpdateMemberToast: true });
    const updateMember = capturedMutations[2];
    const context = await updateMember?.onMutate?.({ memberId: 'm1', role: 'admin' });

    updateMember?.onError?.(new Error('boom'), { memberId: 'm1', role: 'admin' }, context);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('rename: a failing older rename does not roll back while a newer rename owns the cache', async () => {
    getQueryDataMock.mockReturnValue({ name: 'Old', members: [] });
    useOrganizationMutations(ORG_ID);
    const rename = capturedMutations[0];
    const older = await rename?.onMutate?.({ name: 'A' });
    const newer = await rename?.onMutate?.({ name: 'B' });

    setQueryDataMock.mockClear();
    rename?.onError?.(new Error('boom'), { name: 'A' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    rename?.onError?.(new Error('boom'), { name: 'B' }, newer);
    // rename rolls back both the withMembers and the list caches.
    expect(setQueryDataMock).toHaveBeenCalledTimes(2);
    // rename renders inline (no toast).
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('updateMinimumBalanceAlert renders inline (no toast) and rolls back the latest snapshot', async () => {
    getQueryDataMock.mockReturnValue({ settings: {} });
    useOrganizationMutations(ORG_ID);
    const updateMinimumBalanceAlert = capturedMutations[5];
    const context = await updateMinimumBalanceAlert?.onMutate?.({ enabled: true });

    setQueryDataMock.mockClear();
    updateMinimumBalanceAlert?.onError?.(new Error('boom'), { enabled: true }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('scope.id network serialization (real MutationCache)', () => {
  it('starts the second same-scope org mutationFn only after the first settles', async () => {
    const { MutationCache, QueryClient } =
      await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
    const cache = new MutationCache();
    const client = new QueryClient({ mutationCache: cache });
    const order: string[] = [];
    const gate = Promise.withResolvers<null>();

    const first = cache.build(client, {
      mutationFn: async () => {
        order.push('first-start');
        await gate.promise;
        order.push('first-end');
        return 'first';
      },
      scope: { id: `organization:${ORG_ID}` },
    });
    const second = cache.build(client, {
      mutationFn: async () => {
        order.push('second-start');
        return 'second';
      },
      scope: { id: `organization:${ORG_ID}` },
    });

    const p1 = first.execute({});
    const p2 = second.execute({});
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    gate.resolve(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
