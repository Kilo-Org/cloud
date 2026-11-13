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
}));

vi.mock('expo-router', () => ({ useRouter: () => mockRouter }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => mocks.state }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Crown: 'Crown' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/form-sheet', () => ({
  useSheetHeaderTopClearance: () => mockClearance.windowTop,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ kiloPass: { getState: { queryOptions: () => ({}) } } }),
}));

function subscription(overrides: Partial<KiloPassSubscription> = {}): KiloPassSubscription {
  return {
    tier: 'tier_49',
    cadence: 'monthly',
    status: 'active',
    cancelAtPeriodEnd: false,
    resumesAt: null,
    endedAt: null,
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

  it('names the plan and the day a lapsed pass ended', async () => {
    mocks.state.data = {
      subscription: subscription({
        status: 'canceled',
        endedAt: '2026-11-08T04:05:06.000Z',
      }),
      isEligibleForFirstMonthPromo: false,
    };
    const renderer = await renderScreen();
    const text = allText(renderer);
    expect(text).toContain('Pro · Monthly');
    expect(text).toContain('Ended Nov 8, 2026');
    // The ended surface reports state only: no manage, cancel, or buy action.
    expect(nodesOfType(renderer, 'Button')).toHaveLength(0);
    expect(nodesOfType(renderer, 'KvRow')).toHaveLength(0);
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
    expect(allText(renderer)).toContain('Canceling');
    const rows = nodesOfType(renderer, 'KvRow');
    expect(rows[0]?.props.label).toBe('Active until');
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
