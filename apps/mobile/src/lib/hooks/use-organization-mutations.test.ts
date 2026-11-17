/* eslint-disable require-await, @typescript-eslint/require-await -- the second mutationFn resolves immediately without awaiting */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ReactQuery from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
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
    // Like the adapter: no second argument when the caller passed no options,
    // so a bare-copy assertion keeps matching only for a bare call.
    error: (msg: string, options?: unknown) =>
      options === undefined ? toastErrorMock(msg) : toastErrorMock(msg, options),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

// The role read lives beside the refusal hooks, whose module pulls in the
// router and the boundary query. This suite drives the role directly, so the
// toast's copy and its optional step are the only things under test.
const role = vi.hoisted(() => ({
  canManageBilling: false,
  action: undefined as { label: string; onPress: () => void } | undefined,
}));

vi.mock('@/lib/trial-refusal', () => ({
  useCanManageBilling: () => role.canManageBilling,
  useBillingAction: () => role.action,
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
    role.canManageBilling = false;
    role.action = undefined;
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
    // A rejection the app has no explanation for shows the localized generic
    // line, never the server's own sentence.
    expect(toastErrorMock).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
  });

  it('updateMember stays inline (no toast) when silenceMemberToast is set', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    useOrganizationMutations(ORG_ID, { silenceMemberToast: true });
    const updateMember = capturedMutations[2];
    const removeMember = capturedMutations[3];
    const context = await updateMember?.onMutate?.({ memberId: 'm1', role: 'admin' });

    updateMember?.onError?.(new Error('boom'), { memberId: 'm1', role: 'admin' }, context);
    expect(toastErrorMock).not.toHaveBeenCalled();

    // member-row owns the removal's refusal too (the members screen renders
    // it), so the removal stays silent for the same caller.
    const removalContext = await removeMember?.onMutate?.({ memberId: 'm1' });
    removeMember?.onError?.(new Error('boom'), { memberId: 'm1' }, removalContext);
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

  const trialRefusal = () =>
    Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
      data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
    });

  it('toasts the plan refusal with the billing step for a role that can change the plan', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    const onPress = vi.fn<() => void>();
    role.canManageBilling = true;
    role.action = { label: i18n.t('organization.hub.manageBilling'), onPress };
    useOrganizationMutations(ORG_ID);
    const removeMember = capturedMutations[3];
    const context = await removeMember?.onMutate?.({ memberId: 'm1' });

    removeMember?.onError?.(trialRefusal(), { memberId: 'm1' }, context);

    expect(toastErrorMock).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBilling'), {
      action: { label: i18n.t('organization.hub.manageBilling'), onClick: expect.any(Function) },
    });
    const options = toastErrorMock.mock.calls[0]?.[1] as
      | { action: { onClick: () => void } }
      | undefined;
    if (!options) {
      throw new Error('the toast carried no step');
    }
    options.action.onClick();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps a member on the owner-naming copy with no step', async () => {
    getQueryDataMock.mockReturnValue({ members: [] });
    useOrganizationMutations(ORG_ID);
    const removeMember = capturedMutations[3];
    const context = await removeMember?.onMutate?.({ memberId: 'm1' });

    removeMember?.onError?.(trialRefusal(), { memberId: 'm1' }, context);

    // One argument: a reader who cannot end the refusal is offered nothing.
    expect(toastErrorMock.mock.calls[0]).toEqual([i18n.t('common.organizationTrialEnded')]);
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
