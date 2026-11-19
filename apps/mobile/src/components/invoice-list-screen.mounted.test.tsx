// The invoice list both scopes render. A pull is the only way to ask for a
// fresh page while rows are already on screen, so the gesture lives on the
// body's scroller in both branches: the empty state's scroller when the read
// settled with no rows, the paged list when it settled with rows. One control,
// one target — the shared `useManualRefresh` around the read's `refetch`.
import {
  createElement,
  type ElementType,
  type ReactElement,
  type Ref,
  useImperativeHandle,
} from 'react';
import { type Href } from 'expo-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { type Invoice } from '@/components/invoice-list-row';

import { InvoiceListScreen } from './invoice-list-screen';

const native = vi.hoisted(() => {
  // The surface `CenteredState` requires. A measured 0..500 band keeps the
  // empty state on its pending placement, which is the placement a screen
  // paints before its first measurement.
  const surface = {
    frame: { top: 0, bottom: 500 },
    bounds: { top: 0, bottom: 500 },
    safeAreaTop: 0,
    safeAreaBottom: 0,
    source: 'layout',
    topInset: 0,
    bottomInset: 0,
    topReservation: 0,
    bottomReservation: 0,
    nativeViewportFillsSurface: false,
    register: vi.fn(() => vi.fn()),
  };
  return { surface, scroll: { getNativeScrollRef: () => undefined } };
});

// `CenteredState` throws without a surface, and the surface is a provider the
// app mounts above a screen that owns one.
vi.mock('@/components/centered-state-surface', () => ({
  useStateSurface: () => native.surface,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
  PixelRatio: { roundToNearestPixel: (value: number) => Math.round(value * 2) / 2 },
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 400, height: 900, scale: 2, fontScale: 1 }),
  View: 'View',
  ScrollView: ({
    ref,
    ...props
  }: { ref?: Ref<{ getNativeScrollRef: () => undefined }> } & Record<string, unknown>) => {
    // `CenteredState` measures through the scroller's native node; a handle
    // with no node keeps the state on its pending placement.
    useImperativeHandle(ref, () => native.scroll);
    return createElement('ScrollView', props);
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

// The host keeps every prop the caller hands it, so the suite reads the list's
// own `refreshControl` instead of a forwarded gesture.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => createElement('FlashList', props),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/invoice-list-row', () => ({ InvoiceRow: 'InvoiceRow' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  FileText: 'FileText',
  Loader2: 'Loader2',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

type PullControl = ReactElement<{ refreshing: boolean; onRefresh: () => void }>;

/** One invoice in the shape both scopes return; the rows are not rendered here. */
const invoice: Invoice = {
  id: 'in_1',
  number: 'KL-0001',
  status: 'paid',
  amount_due: 1200,
  currency: 'usd',
  created: 1_791_000_000,
  hosted_invoice_url: null,
  invoice_pdf: null,
};

type QueryFixture = {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  error: unknown;
  data: { pages: readonly unknown[] } | undefined;
  refetch: () => Promise<{ isError: boolean }>;
  fetchNextPage: () => void;
};

/** A read that settled successfully with no failure anywhere. */
function settledQuery(): QueryFixture {
  // The pull reads the settled result, so the spy resolves one.
  const refetch = vi.fn<() => Promise<{ isError: boolean }>>();
  refetch.mockResolvedValue({ isError: false });
  return {
    isPending: false,
    isError: false,
    isFetching: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    error: undefined,
    data: { pages: [{ entries: [], nextCursor: null }] },
    refetch,
    fetchNextPage: vi.fn<() => void>(),
  };
}

let mounted: RenderWithProvidersResult | undefined = undefined;

async function mount(
  entries: readonly Invoice[],
  query: QueryFixture
): Promise<RenderWithProvidersResult> {
  mounted = await renderWithProviders(
    createElement(InvoiceListScreen, {
      title: 'organization.invoices.title',
      backFallback: '/' as Href,
      query,
      entries,
      hasMore: false,
      emptyTitle: 'organization.invoices.emptyTitle',
      emptyDescription: 'invoices.personalEmptyDescription',
    })
  );
  return mounted;
}

/** The pull gesture a pull-to-refresh surface carries; a missing one fails the test. */
function pullControl(host: ReactTestInstance): PullControl {
  const control = host.props.refreshControl as PullControl | undefined;
  if (!control) {
    throw new Error(`${String(host.type)} rendered no pull control`);
  }
  return control;
}

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('InvoiceListScreen pull to refresh', () => {
  it('puts the pull on the empty state scroller and refetches from it', async () => {
    const query = settledQuery();
    const view = await mount([], query);
    const scroll = view.renderer.root.findByType('ScrollView' as ElementType);
    const control = pullControl(scroll);
    expect(control.type).toBe('RefreshControl');
    expect(control.props.refreshing).toBe(false);
    // The gesture is not in flight, so nothing spins until the pull starts.
    expect(query.refetch).not.toHaveBeenCalled();

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('hands the same control to the list when rows are present', async () => {
    const query = settledQuery();
    const view = await mount([invoice], query);
    const [list] = view.renderer.root.findAllByType('FlashList' as ElementType);
    if (!list) {
      throw new Error('the rows were not handed to the list');
    }
    const control = pullControl(list);
    expect(control.type).toBe('RefreshControl');
    // The in-list empty component is only ever shown mid-list; the gesture
    // belongs to the list itself.
    expect(
      (list.props.ListEmptyComponent as ReactElement<{ refreshControl?: unknown }>).props
        .refreshControl
    ).toBeUndefined();

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});
