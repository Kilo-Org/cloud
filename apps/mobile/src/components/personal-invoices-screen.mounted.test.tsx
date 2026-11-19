// Personal invoices header contract: the person's own list titles itself with
// the screen's name and paints no eyebrow, so only the organization scope swaps
// a membership's name into the title. The scope reads are mocked, the same way
// the organization suite drives its states.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
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
    subtitle?: string;
    eyebrow?: string;
    reserveEyebrow?: boolean;
  }[],
}));

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

const emptyStates = vi.hoisted(() => ({
  rendered: [] as {
    title?: string;
    placement?: string;
    action?: unknown;
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
  EmptyState: (props: { title: string; placement?: string; action?: unknown }) => {
    emptyStates.rendered.push(props);
    return createElement('EmptyState', props, `EMPTY_STATE:${props.title}`);
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: navigation.push }) }));

vi.mock('@/components/query-error', () => ({
  QueryError: () => null,
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: {
    title?: string;
    subtitle?: string;
    eyebrow?: string;
    reserveEyebrow?: boolean;
  }) => {
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
  emptyStates.rendered = [];
  navigation.push.mockClear();
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

  it("labels the header with the list's fixed one-year window", async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: null, hasMore: false }] };
    pageHook.entries = [INVOICE];

    await renderWithProviders(createElement(PersonalInvoicesScreen));

    expect(screenHeaders.rendered).toHaveLength(1);
    expect(screenHeaders.rendered[0]?.subtitle).toBe(i18n.t('invoices.personalPeriod'));
  });

  it("routes the empty state's action to the credit history screen", async () => {
    // No pages: the read settled with zero invoices, so the empty state with
    // its action renders in the centered branch.
    pageQuery.data = { pages: [] };
    pageHook.entries = [];

    await renderWithProviders(createElement(PersonalInvoicesScreen));

    expect(emptyStates.rendered).toHaveLength(1);
    // The action is the screen's own outline Button element: its Text child
    // reads the credit-history screen's name, and its press pushes the route.
    const action = emptyStates.rendered[0]?.action as {
      props?: { onPress?: () => void; children?: { props?: { children?: string } } };
    };
    expect(action).toBeDefined();
    expect(action.props?.children?.props?.children).toBe(i18n.t('common.creditHistory'));

    const onPress = action.props?.onPress;
    expect(onPress).toBeDefined();
    await act(() => {
      onPress?.();
    });
    expect(navigation.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/credit-history');
  });
});
