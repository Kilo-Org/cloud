// Personal invoices header contract: the person's own list titles itself with
// the screen's name and paints no eyebrow, so only the organization scope swaps
// a membership's name into the title. The scope reads are mocked, the same way
// the organization suite drives its states.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: 'FlashList',
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
    // The personal header keeps the header's default tail ellipsis and paints
    // no eyebrow.
    expect(screenHeaders.rendered[0]).not.toHaveProperty('titleEllipsizeMode');
  });
});
