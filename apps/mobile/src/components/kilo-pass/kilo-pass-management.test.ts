import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';

import { KiloPassManagementSections } from './kilo-pass-management';
import { type KiloPassSubscriptionState } from '@/lib/kilo-pass/management';

const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  reconcileFirstPage: vi.fn(),
  confirm: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  /** The options each mutation handed the query client. */
  mutations: [] as { onSuccess?: () => void }[],
}));

const trpc = vi.hoisted(() => ({
  kiloPass: {
    getState: { pathKey: () => ['kiloPass', 'getState'] as const },
    getScheduledChange: { pathKey: () => ['kiloPass', 'getScheduledChange'] as const },
    getBillingHistory: {
      pathFilter: () => ({ queryKey: ['kiloPass', 'getBillingHistory'] as const }),
    },
    getCreditHistory: {
      pathFilter: () => ({ queryKey: ['kiloPass', 'getCreditHistory'] as const }),
    },
    cancelSubscription: { mutationOptions: (options: unknown) => options },
    resumeCancelledSubscription: { mutationOptions: (options: unknown) => options },
    resumePausedSubscription: { mutationOptions: (options: unknown) => options },
    cancelScheduledChange: { mutationOptions: (options: unknown) => options },
  },
}));

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, View: 'View' }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onSuccess?: () => void }) => {
    mocks.mutations.push(options);
    return { isPending: false, mutate: () => options.onSuccess?.() };
  },
  useQueryClient: () => queryClient,
}));
vi.mock('sonner-native', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, dialog: null }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/credits/external-billing-link', () => ({ canOpenExternalBilling: () => true }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/query/infinite-retention', () => ({
  reconcileFirstPage: mocks.reconcileFirstPage,
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpc }));

/** A live stripe-billed pass: the one shape this surface cancels. */
function passState(): KiloPassSubscriptionState {
  return {
    subscriptionId: 'kps_1',
    stripeSubscriptionId: 'sub_1',
    paymentProvider: 'stripe' as KiloPassSubscriptionState['paymentProvider'],
    providerSubscriptionId: 'sub_1',
    tier: 'tier_49' as KiloPassSubscriptionState['tier'],
    cadence: 'monthly' as KiloPassSubscriptionState['cadence'],
    status: 'active',
    cancelAtPeriodEnd: false,
    currentStreakMonths: 3,
    nextYearlyIssueAt: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    resumesAt: null,
    nextBonusCreditsUsd: 9.8,
    nextBillingAt: '2026-12-05T12:00:00.000Z',
    isFirstTimeSubscriberEver: false,
    currentPeriodBaseCreditsUsd: 49,
    currentPeriodUsageUsd: 12.5,
    currentPeriodHostingCostUsd: 0,
    currentPeriodBonusCreditsUsd: 9.8,
    currentPeriodBonus: {
      status: 'available',
      kind: null,
      actualAmountUsd: null,
      projectedAmountUsd: 9.8,
    },
    isBonusUnlocked: true,
    isBonusAvailableToUnlock: false,
    refillAt: '2026-12-05T12:00:00.000Z',
  };
}

async function renderSections(): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(
      createElement(KiloPassManagementSections, {
        subscription: passState(),
        scheduledChange: null,
      })
    );
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('KiloPassManagementSections', () => {
  beforeEach(() => {
    queryClient.invalidateQueries.mockClear();
    mocks.reconcileFirstPage.mockClear();
    mocks.confirm.mockReset();
  });

  it('refreshes page one of each ledger instead of every retained page', async () => {
    const renderer = await renderSections();
    const [cancel] = renderer.root.findAll(node => String(node.type) === 'Button');
    if (!cancel) {
      throw new Error('The cancel action did not render');
    }
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    const confirmation = mocks.confirm.mock.calls[0]?.[0] as { onConfirm: () => void };
    act(() => {
      confirmation.onConfirm();
    });

    // A plain invalidation re-requests every retained page, and each billing
    // page is one Stripe `invoices.list` call.
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'kiloPass',
      'getBillingHistory',
    ]);
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'kiloPass',
      'getCreditHistory',
    ]);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['kiloPass', 'getBillingHistory'],
    });
    // The two single-page reads still refresh outright.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['kiloPass', 'getState'],
    });
    renderer.unmount();
  });
});
