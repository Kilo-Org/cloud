// The dev-only personal invoices fixture. `error` makes the one read reject the
// way a network or backend read failure does, so the production screen and its
// pagination hook reach the retryable neutral error state with the header still
// painting the list's subtitle.

import { type MobileRouter } from '@kilocode/trpc/mobile';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { PersonalInvoicesFixture } from './personal-invoices-fixture';

// The fixture brings its own client and query client; mock the app module the
// same way the hook suites do so the provider context comes from the real tRPC
// React context instead of the app's auth/telemetry stack. `vi.mock` factories
// are hoisted above static imports, so this one imports lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  return createTRPCContext<MobileRouter>();
});

const emptyStates = vi.hoisted(() => ({
  rendered: [] as {
    title?: string;
    description?: { props?: { message?: string } };
    action?: { props?: { accessibilityLabel?: string } };
  }[],
}));

const screenHeaders = vi.hoisted(() => ({
  rendered: [] as { title?: string; subtitle?: string }[],
}));

const connectivity = vi.hoisted(() => ({ value: 'online' as 'online' | 'offline' | 'unknown' }));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
  useCommittedConnectivityStatus: () => connectivity.value,
  useOfflineBannerState: () => connectivity.value === 'offline',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray', destructive: 'red' }),
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/invoice-download', () => ({
  selectInvoiceRowState: () => 'no-affordance',
  getInvoiceDownloadErrorMessage: String,
  shareInvoicePdf: vi.fn(),
}));

// The pull-to-refresh failure announcement is not what this state exercises.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// Captured rather than rendered, so the assertions read the exact copy the real
// QueryError and ScreenHeader were given.
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: {
    title?: string;
    description?: { props?: { message?: string } };
    action?: { props?: { accessibilityLabel?: string } };
  }) => {
    emptyStates.rendered.push(props);
    return null;
  },
  // The retryable state's action; the suite asserts the captured state, not it.
  StateAction: () => null,
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; subtitle?: string }) => {
    screenHeaders.rendered.push(props);
    return null;
  },
}));

vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown }) => props.children ?? null,
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Download: 'Download',
  FileText: 'FileText',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));

vi.mock('@/components/tab-screen', () => ({
  useTabBarBottomPadding: () => 0,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: vi.fn(),
  useNavigation: () => ({}),
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/lib/format', () => ({
  formatDate: String,
  formatPrefixedMoney: (amount: number) => `$${amount}`,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  firstNonEmpty: (...args: (string | null | undefined)[]) =>
    args.find(value => value != null && value !== '') ?? '',
}));

beforeEach(() => {
  connectivity.value = 'online';
  emptyStates.rendered = [];
  screenHeaders.rendered = [];
});

describe('PersonalInvoicesFixture error state', () => {
  it('reaches the retryable neutral QueryError under the list subtitle', async () => {
    await renderWithProviders(createElement(PersonalInvoicesFixture, { state: 'error' }));
    await waitFor(() => emptyStates.rendered.length === 1);

    // The rejected read classifies as `unknown`, so the screen keeps the neutral
    // copy and offers Retry — the retryable variant, not a permanent state.
    const errorState = emptyStates.rendered[0];
    expect(errorState?.title).toBe(i18n.t('common.somethingWentWrong'));
    expect(errorState?.description?.props?.message).toBe(i18n.t('queryError.neutralDescription'));
    expect(errorState?.action?.props?.accessibilityLabel).toBe(i18n.t('common.retry'));

    // The header repaints as the read settles, so every render carries the same
    // subtitle: the list's name stays above the error state.
    expect(screenHeaders.rendered.length).toBeGreaterThan(0);
    expect(
      screenHeaders.rendered.every(header => header.subtitle === i18n.t('invoices.personalPeriod'))
    ).toBe(true);
  });
});
