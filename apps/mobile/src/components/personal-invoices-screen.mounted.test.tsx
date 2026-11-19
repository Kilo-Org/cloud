// Personal invoices header contract: the person's own list titles itself with
// the screen's name and paints no eyebrow, so only the organization scope swaps
// a membership's name into the title. The scope reads are mocked, the same way
// the organization suite drives its states.

import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
import { PersonalInvoicesScreen } from './personal-invoices-screen';

const pageQuery = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  data: null as unknown,
  error: null as unknown,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

const pageHook = vi.hoisted(() => ({
  entries: [] as unknown[],
  hasMore: false,
  isRetentionLimited: false,
}));

const connectivity = vi.hoisted(() => ({ value: 'online' as 'online' | 'offline' | 'unknown' }));

const screenHeaders = vi.hoisted(() => ({
  rendered: [] as {
    title?: string;
    eyebrow?: string;
    reserveEyebrow?: boolean;
  }[],
}));

vi.mock('@/lib/hooks/use-personal-credits', () => ({
  usePersonalInvoicesPage: () => ({
    query: pageQuery,
    entries: pageHook.entries,
    hasMore: pageHook.hasMore,
    isRetentionLimited: pageHook.isRetentionLimited,
  }),
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
  useCommittedConnectivityStatus: () => connectivity.value,
  useOfflineBannerState: () => connectivity.value === 'offline',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray' }),
}));

vi.mock('@/lib/invoice-download', () => ({
  selectInvoiceRowState: () => 'no-affordance',
  getInvoiceDownloadErrorMessage: String,
  shareInvoicePdf: vi.fn(),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/format', () => ({
  formatDate: String,
  formatPrefixedMoney: (amount: number) => `$${amount}`,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  firstNonEmpty: (...args: (string | null | undefined)[]) =>
    args.find(value => value != null && value !== '') ?? '',
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; placement?: string }) =>
    createElement('EmptyState', props, `EMPTY_STATE:${props.title}`),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: () => null,
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; eyebrow?: string; reserveEyebrow?: boolean }) => {
    screenHeaders.rendered.push(props);
    return null;
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown }) => props.children ?? null,
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/icons', () => ({ Download: 'Download', FileText: 'FileText' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The pull control reaches the reduced-motion policy, which loads expo-battery;
// this suite drives the header contract, not the gesture's indicator.
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: { ListFooterComponent?: ReactElement }) =>
    createElement('FlashList', props, props.ListFooterComponent ?? null),
}));

vi.mock('@/components/tab-screen', () => ({
  useTabBarBottomPadding: () => 0,
}));

const INVOICE = {
  id: 'inv-1',
  number: 'INV-0001',
  description: 'Credits',
  amount_due: 5000,
  created: 1_710_000_000,
  status: 'paid',
  invoice_pdf: null,
};

beforeEach(() => {
  pageQuery.data = null;
  pageHook.entries = [];
  pageHook.hasMore = false;
  pageHook.isRetentionLimited = false;
  connectivity.value = 'online';
  screenHeaders.rendered = [];
});

describe('PersonalInvoicesScreen header', () => {
  it('keeps the screen name as the title and paints no eyebrow', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: null, hasMore: false }] };
    pageHook.entries = [INVOICE];

    await renderWithProviders(createElement(PersonalInvoicesScreen));

    expect(screenHeaders.rendered).toHaveLength(1);
    expect(screenHeaders.rendered[0]?.title).toBe(i18n.t('organization.invoices.title'));
    expect(screenHeaders.rendered[0]?.eyebrow).toBeUndefined();
    expect(screenHeaders.rendered[0]?.reserveEyebrow).toBeUndefined();
  });
});

/** Every string the screen paints, so a footer note is visible to a test. */
function flattenText(node: ReactTestInstance): string[] {
  const collected: string[] = [];
  const walk = (instance: ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        collected.push(child);
      } else if (typeof child !== 'number') {
        walk(child);
      }
    }
  };
  walk(node);
  return collected;
}

describe('PersonalInvoicesScreen retention-limit footer', () => {
  it('names the retention bound with no Load more at the bound', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: null, hasMore: false }] };
    pageHook.entries = [INVOICE];
    pageHook.isRetentionLimited = true;

    const { renderer } = await renderWithProviders(createElement(PersonalInvoicesScreen));

    const texts = flattenText(renderer.root);
    // This suite renders the real catalogs, so the assertions read the copy.
    expect(texts).toContain(i18n.t('organization.invoices.retentionLimit'));
    // The bound note replaces the Load more block, so its label never renders.
    expect(texts).not.toContain(i18n.t('common.loadMore'));
  });

  it('keeps the truncated note and Load more below the bound', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: 'inv-1', hasMore: true }] };
    pageHook.entries = [INVOICE];
    pageHook.hasMore = true;

    const { renderer } = await renderWithProviders(createElement(PersonalInvoicesScreen));

    const texts = flattenText(renderer.root);
    expect(texts).toContain(i18n.t('organization.invoices.truncated'));
    expect(texts).not.toContain(i18n.t('organization.invoices.retentionLimit'));
    expect(texts).toContain(i18n.t('common.loadMore'));
  });

  it('never renders the two notes together when the impossible flag pairing is forced', async () => {
    // The hooks can never return bound flag and `hasMore` together, so force
    // the pairing from the mock side and hold the footer to one note.
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: 'inv-1', hasMore: true }] };
    pageHook.entries = [INVOICE];
    pageHook.hasMore = true;
    pageHook.isRetentionLimited = true;

    const { renderer } = await renderWithProviders(createElement(PersonalInvoicesScreen));

    const texts = flattenText(renderer.root);
    expect(texts).not.toContain(i18n.t('organization.invoices.retentionLimit'));
    expect(texts).toContain(i18n.t('organization.invoices.truncated'));
    expect(texts).toContain(i18n.t('common.loadMore'));
  });
});
