import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { type CreditPurchaseEntry } from '@/lib/credits/credit-history';

import { PersonalCreditHistoryScreen } from './credit-history-screen';

// FlashList renders through callbacks, so the mock walks `data` and mounts the
// footer the way the real list does; a host-string mock would drop both.
const flashListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly unknown[];
      renderItem?: (info: { item: unknown; index: number }) => ReactNode;
      ListFooterComponent?: ReactNode;
    }) =>
      createElement(
        'FlashList',
        null,
        ...props.data.map((item, index) =>
          createElement(
            'FlashListRow',
            { key: String(index) },
            props.renderItem ? props.renderItem({ item, index }) : null
          )
        ),
        props.ListFooterComponent
          ? createElement('FlashListFooter', null, props.ListFooterComponent)
          : null
      )
);

const state = vi.hoisted(() => ({
  purchases: {
    query: {
      status: 'success' as string,
      isError: false,
      isFetchNextPageError: false,
      isFetching: false,
      isFetchingNextPage: false,
      error: null as unknown,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    },
    entries: [] as unknown[],
    hasMore: false,
  },
  blocks: {
    data: undefined as unknown,
    isError: false,
    isPending: false,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock('@shopify/flash-list', () => ({ FlashList: flashListMock }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ Receipt: 'Receipt' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'min-h-[48px]' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/credits/credit-history-rows', () => ({
  PurchaseHistoryRow: 'PurchaseHistoryRow',
  LedgerHistoryRow: 'LedgerHistoryRow',
}));
vi.mock('@/lib/hooks/use-personal-credits', () => ({
  useCreditPurchaseHistory: () => state.purchases,
  usePersonalCreditBlocks: () => state.blocks,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getCreditPurchaseReceipt: {
        mutationOptions: () => ({
          mutationFn: () => Promise.resolve({ url: null }),
        }),
      },
    },
  }),
}));

function purchase(overrides: Partial<CreditPurchaseEntry> = {}): CreditPurchaseEntry {
  return {
    id: 'purchase-1',
    date: '2026-11-12T10:00:00.000Z',
    description: 'Credit purchase',
    amount_mUsd: 10_000_000,
    expiryDate: '2027-11-12T00:00:00.000Z',
    creditSource: 'stripe',
    ...overrides,
  };
}

function nodesOfType(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => String(node.type) === type);
}

/** Every string the screen paints, so a hidden line is visible to a test. */
function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  const collected: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        collected.push(child);
      } else if (typeof child !== 'number') {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return collected;
}

beforeEach(() => {
  state.purchases.query.status = 'success';
  state.purchases.query.isError = false;
  state.purchases.query.isFetchNextPageError = false;
  state.purchases.query.isFetching = false;
  state.purchases.query.isFetchingNextPage = false;
  state.purchases.query.error = null;
  state.purchases.query.refetch.mockClear();
  state.purchases.query.fetchNextPage.mockClear();
  state.purchases.entries = [];
  state.purchases.hasMore = false;
  state.blocks.data = undefined;
  state.blocks.isError = false;
  state.blocks.isPending = false;
  state.blocks.isFetching = false;
  state.blocks.error = null;
  state.blocks.refetch.mockClear();
});

describe('PersonalCreditHistoryScreen', () => {
  it('names the ledger that failed and keeps the loaded purchases under it', async () => {
    state.purchases.entries = [purchase()];
    state.blocks.isError = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(PersonalCreditHistoryScreen)
    );

    // The purchases answered, so their rows stay; the failed ledger says so
    // instead of disappearing from the list without a word.
    expect(nodesOfType(renderer, 'PurchaseHistoryRow')).toHaveLength(1);
    expect(texts(renderer)).toContain("Couldn't load credit activity.");

    const retry = nodesOfType(renderer, 'Button').find(
      node => node.props.accessibilityLabel === 'Retry'
    );
    if (!retry) {
      throw new Error('the ledger retry action did not render');
    }
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(state.blocks.refetch).toHaveBeenCalledTimes(1);
    // Only the part that failed is re-read; the loaded purchases stay put.
    expect(state.purchases.query.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the whole-screen error when the ledger failed with no purchases at all', async () => {
    state.blocks.isError = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(PersonalCreditHistoryScreen)
    );

    expect(nodesOfType(renderer, 'QueryError')).toHaveLength(1);
    expect(nodesOfType(renderer, 'PurchaseHistoryRow')).toHaveLength(0);
    expect(texts(renderer)).not.toContain("Couldn't load credit activity.");
    unmount();
  });

  it('shows no ledger line while the list is healthy', async () => {
    state.purchases.entries = [purchase()];
    const { renderer, unmount } = await renderWithProviders(
      createElement(PersonalCreditHistoryScreen)
    );

    expect(nodesOfType(renderer, 'PurchaseHistoryRow')).toHaveLength(1);
    expect(texts(renderer)).not.toContain("Couldn't load credit activity.");
    unmount();
  });
});
