import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';

import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';
import { type KiloPassSubscription } from '@/lib/kilo-pass/state';

const mockRouter = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const mockClearance = vi.hoisted(() => ({ windowTop: 0 }));
const mocks = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  },
  scheduled: {
    data: undefined as unknown,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  },
  /** Every options object the screen hands the scheduled-change read. */
  scheduledOptions: [] as Record<string, unknown>[],
  ledgers: {
    credit: {
      query: {
        isPending: false,
        isError: false,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        refetch: vi.fn(),
        fetchNextPage: vi.fn(),
      },
      entries: [] as unknown[],
      hasMore: false,
    },
    billing: {
      query: {
        isPending: false,
        isError: false,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        refetch: vi.fn(),
        fetchNextPage: vi.fn(),
      },
      entries: [] as unknown[],
      hasMore: false,
    },
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => mockRouter }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options?: { key?: string }) => {
    if (options?.key === 'scheduled') {
      mocks.scheduledOptions.push(options);
      return mocks.scheduled;
    }
    return mocks.state;
  },
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Crown: 'Crown' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The body's blocks have their own suites. The screen owns which state it
// shows and when it prints the page, so they render as hosts here.
vi.mock('@/components/kilo-pass/kilo-pass-management', () => ({
  KiloPassManagementSections: 'KiloPassManagementSections',
}));
vi.mock('@/components/kilo-pass/kilo-pass-history-sections', () => ({
  KiloPassCreditHistorySection: 'KiloPassCreditHistorySection',
  KiloPassBillingHistorySection: 'KiloPassBillingHistorySection',
}));
vi.mock('@/lib/hooks/use-kilo-pass-history', () => ({
  useKiloPassCreditHistory: () => mocks.ledgers.credit,
  useKiloPassBillingHistory: () => mocks.ledgers.billing,
}));
vi.mock('@/lib/form-sheet', () => ({
  useSheetHeaderTopClearance: () => mockClearance.windowTop,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getState: { queryOptions: () => ({ key: 'state' }) },
      getScheduledChange: { queryOptions: () => ({ key: 'scheduled' }) },
    },
  }),
}));

function subscription(overrides: Partial<KiloPassSubscription> = {}): KiloPassSubscription {
  return {
    tier: 'tier_49',
    cadence: 'monthly',
    status: 'active',
    cancelAtPeriodEnd: false,
    resumesAt: null,
    nextBillingAt: '2026-12-05T12:00:00.000Z',
    refillAt: '2026-12-05T12:00:00.000Z',
    currentPeriodBaseCreditsUsd: 49,
    currentPeriodUsageUsd: 12.5,
    currentPeriodBonus: {
      status: 'available',
      kind: null,
      actualAmountUsd: null,
      projectedAmountUsd: 9.8,
    },
    ...overrides,
  };
}

/** A pass kilo.ai bills, so the screen reads its schedule and invoices. */
function stripeSubscription(overrides: Partial<KiloPassSubscription> = {}) {
  return { ...subscription(overrides), paymentProvider: 'stripe' };
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(KiloPassSubscriptionScreen));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const texts: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else if (typeof child === 'number') {
        texts.push(String(child));
      } else {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return texts.join(' ');
}

function nodesOfType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => String(node.type) === type);
}

describe('KiloPassSubscriptionScreen', () => {
  beforeEach(() => {
    mockClearance.windowTop = 0;
    mocks.state.isPending = false;
    mocks.state.isError = false;
    mocks.state.data = { subscription: null, isEligibleForFirstMonthPromo: true };
    mocks.state.refetch.mockClear();
    mocks.scheduled.isPending = false;
    mocks.scheduled.data = { scheduledChange: null };
    mocks.scheduledOptions.length = 0;
    mocks.ledgers.credit.query.isPending = false;
    mocks.ledgers.billing.query.isPending = false;
    mockRouter.replace.mockClear();
    mockRouter.push.mockClear();
  });

  it('shows the loading skeleton while the pass query is pending', async () => {
    mocks.state.isPending = true;
    const renderer = await renderScreen();
    expect(nodesOfType(renderer, 'Skeleton').length).toBeGreaterThan(0);
    expect(nodesOfType(renderer, 'EmptyState')).toHaveLength(0);
    renderer.unmount();
  });

  it('tells an account without a pass that the app does not offer one', async () => {
    const renderer = await renderScreen();
    const emptyState = nodesOfType(renderer, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    expect(emptyState[0]?.props.title).toBe("Kilo Pass isn't available in the app.");
    // A finished message with no action: the app sells nothing here.
    expect(emptyState[0]?.props.action).toBeUndefined();
    renderer.unmount();
  });

  it('states that a lapsed pass ended', async () => {
    mocks.state.data = {
      subscription: subscription({ status: 'canceled' }),
      isEligibleForFirstMonthPromo: false,
    };
    const renderer = await renderScreen();
    const emptyState = nodesOfType(renderer, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    expect(emptyState[0]?.props.title).toBe('Your Kilo Pass has ended.');
    renderer.unmount();
  });

  it('prints the pass details the web console shows, with no manage action', async () => {
    mocks.state.data = { subscription: subscription(), isEligibleForFirstMonthPromo: false };
    const renderer = await renderScreen();

    expect(allText(renderer)).toContain('Pro · Monthly');
    expect(allText(renderer)).toContain('Active');

    const rows = nodesOfType(renderer, 'KvRow');
    expect(rows.map(row => [row.props.label, row.props.value])).toEqual([
      ['Renews', 'Dec 5, 2026'],
      ["This month's usage", '$12.50 / $58.80'],
      ['Available free bonus', '$9.80'],
    ]);
    expect(rows.at(-1)?.props.last).toBe(true);

    // No button exists on the details surface: managing, cancelling, and
    // buying a pass are web-only.
    expect(nodesOfType(renderer, 'Button')).toHaveLength(0);
    renderer.unmount();
  });

  it('prints a scheduled cancellation as active until the paid-through date', async () => {
    mocks.state.data = {
      subscription: subscription({ cancelAtPeriodEnd: true }),
      isEligibleForFirstMonthPromo: false,
    };
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Cancels on Dec 5, 2026');
    const rows = nodesOfType(renderer, 'KvRow');
    expect(rows[0]?.props.label).toBe('Active until');
    renderer.unmount();
  });

  it('holds the page until a ledger has its first page', async () => {
    mocks.state.data = { subscription: subscription(), isEligibleForFirstMonthPromo: false };
    mocks.ledgers.credit.query.isPending = true;
    const renderer = await renderScreen();
    // Printing the details first would let the ledger grow under the reader
    // and push everything below it.
    expect(nodesOfType(renderer, 'Skeleton').length).toBeGreaterThan(0);
    expect(nodesOfType(renderer, 'KvRow')).toHaveLength(0);
    renderer.unmount();
  });

  it('holds the page while the scheduled change is unresolved', async () => {
    mocks.state.data = { subscription: stripeSubscription(), isEligibleForFirstMonthPromo: false };
    mocks.scheduled.isPending = true;
    const renderer = await renderScreen();
    expect(nodesOfType(renderer, 'Skeleton').length).toBeGreaterThan(0);
    expect(nodesOfType(renderer, 'KvRow')).toHaveLength(0);
    renderer.unmount();
  });

  it('settles the scheduled change even while the device reports offline', async () => {
    mocks.state.data = { subscription: stripeSubscription(), isEligibleForFirstMonthPromo: false };
    const renderer = await renderScreen();
    // The page waits on this read, so it must not pause in `pending` on the
    // default online mode: that neither errors nor answers, and the screen
    // would hold its loading state with no retry.
    expect(mocks.scheduledOptions.at(-1)).toMatchObject({
      networkMode: 'always',
      refetchOnReconnect: true,
    });
    renderer.unmount();
  });

  it('hands each resolved block the value the page already read', async () => {
    mocks.state.data = { subscription: stripeSubscription(), isEligibleForFirstMonthPromo: false };
    const renderer = await renderScreen();
    const sections = renderer.root.findAll(node =>
      ['KiloPassCreditHistorySection', 'KiloPassBillingHistorySection'].includes(String(node.type))
    );
    // A block that read its own ledger would fetch a second time and settle
    // after the page printed.
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const history =
        String(section.type) === 'KiloPassCreditHistorySection'
          ? mocks.ledgers.credit
          : mocks.ledgers.billing;
      expect(section.props.history).toBe(history);
    }
    renderer.unmount();
  });

  it('keeps a failed pass query retryable', async () => {
    mocks.state.isError = true;
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain("Couldn't load Kilo Pass.");
    expect(allText(renderer)).toContain('Kilo Pass could not be loaded. Try again.');
    const retry = renderer.root.findByProps({ accessibilityLabel: 'Retry loading Kilo Pass' });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(mocks.state.refetch).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('clears the window top inset itself when the modal surface reaches the window top', async () => {
    mockClearance.windowTop = 51.8;
    const renderer = await renderScreen();
    const header = nodesOfType(renderer, 'ScreenHeader')[0];
    expect(header?.props.safeAreaTop).toBe(false);
    expect(String(header?.props.className)).toContain('pt-2');
    // `safeAreaTop: false` only stops the header drawing the inset; the surface
    // that owns the window top pads it, or the header sits under the status bar.
    const padded = nodesOfType(renderer, 'View').filter(
      node => (node.props.style as { paddingTop?: number } | undefined)?.paddingTop === 51.8
    );
    expect(padded).toHaveLength(1);
    renderer.unmount();
    mockClearance.windowTop = 0;
  });

  it('keeps the header inset when the sheet presents below the window top', async () => {
    const renderer = await renderScreen();
    const header = nodesOfType(renderer, 'ScreenHeader')[0];
    expect(header?.props.safeAreaTop).toBe(true);
    expect(header?.props.className).toBeUndefined();
    renderer.unmount();
  });
});
