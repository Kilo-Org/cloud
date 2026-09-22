/* eslint-disable max-lines -- The Buy credits screen's state and retry-path tests share the same screen, query client and IAP-owner mocks; splitting them would duplicate that harness. */
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { CreditPurchaseScreen } from './credit-purchase-screen';

// ── Mutable state ────────────────────────────────────────────────────

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));

const backend = vi.hoisted(() => ({
  response: {
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: [] as { amountUsd: number; appleProductId: string; googleProductId: string }[],
  },
}));

const owner = vi.hoisted(() => ({
  connected: true,
  fetchStoreProducts: vi.fn(),
  purchase: vi.fn(),
  completingProductId: null as string | null,
  errorMessageKey: null as string | null,
  completedPurchaseCount: 0,
  clearError: vi.fn(),
}));

const balance = vi.hoisted(() => ({ balance: 1234 }));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

// The iOS announcement channel behind AccessibleStatus. The screen renders the
// purchase error inline and suppresses the error toast, so this hook (plus
// Android's live region) is the only thing a screen reader can hear.
const statusAnnouncement = vi.hoisted(() => ({ useStatusAnnouncement: vi.fn() }));

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

vi.mock('sonner-native', () => ({ toast: toastMock }));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/detail-screen', () => ({
  DetailScreenScrollView: 'DetailScreenScrollView',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/status-announcement', () => ({
  useStatusAnnouncement: statusAnnouncement.useStatusAnnouncement,
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.com' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/kilo-pass/legal-links', () => ({
  getStoreLegalLinks: () => [
    { url: 'https://example.com/privacy-app', label: 'Privacy Policy' },
    { url: 'https://example.com/terms-app', label: 'Terms of Use (EULA)' },
  ],
}));
vi.mock('@/lib/credits/use-store-credit-purchase', () => ({
  useInlinePurchaseErrorOwnership: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1', isLoading: false, isError: false }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    credits: {
      getMobileStoreProducts: {
        queryOptions: () => ({
          queryKey: ['credits', 'getMobileStoreProducts'],
          queryFn: () => backend.response,
        }),
      },
    },
    user: {
      getContextBalance: {
        queryOptions: () => ({
          queryKey: ['user', 'getContextBalance', {}],
          queryFn: () => ({ balance: balance.balance, isDepleted: false }),
        }),
      },
    },
  }),
}));
vi.mock('./credit-native-iap-owner', () => ({
  useCreditNativeIap: () => owner,
}));
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(arg => typeof arg === 'string').join(' '),
}));

// ── Fixtures and helpers ─────────────────────────────────────────────

const BACKEND_PRODUCTS = [
  { amountUsd: 10, appleProductId: 'credits.usd10.v1', googleProductId: 'credits_usd10' },
  { amountUsd: 50, appleProductId: 'credits.usd50.v1', googleProductId: 'credits_usd50' },
  { amountUsd: 100, appleProductId: 'credits.usd100.v1', googleProductId: 'credits_usd100' },
  { amountUsd: 500, appleProductId: 'credits.usd500.v1', googleProductId: 'credits_usd500' },
];

const STORE_LISTINGS = [
  { id: 'credits.usd10.v1', displayPrice: '$10.99' },
  { id: 'credits.usd50.v1', displayPrice: '$54.99' },
  { id: 'credits.usd100.v1', displayPrice: '$109.99' },
  { id: 'credits.usd500.v1', displayPrice: '$549.99' },
];

/**
 * The shell a pack row and its loading placeholder share. The placeholder must
 * reserve the row's own height (p-5 around one text-base line), not Kilo Pass's
 * two-line 112px block, or the swap moves the legal copy down the page.
 */
const PACK_ROW_SHELL = 'rounded-xl border border-border bg-card p-5';

function placeholderShells(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'View' &&
      (node.props as { className?: string }).className === PACK_ROW_SHELL
  );
}

function classNamesOf(instances: TestRenderer.ReactTestInstance[]): string[] {
  return instances.map(instance => String((instance.props as { className?: string }).className));
}

function packRows(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'Pressable' &&
      typeof (node.props as { accessibilityLabel?: unknown }).accessibilityLabel === 'string' &&
      (node.props as { accessibilityLabel: string }).accessibilityLabel.includes('of credits')
  );
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

function tryAgainButton(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance | undefined {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'Button' &&
      (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Try again'
  )[0];
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CreditPurchaseScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    backend.response = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: BACKEND_PRODUCTS,
    };
    owner.connected = true;
    owner.fetchStoreProducts.mockResolvedValue(STORE_LISTINGS);
    owner.purchase.mockResolvedValue(true);
    owner.completingProductId = null;
    owner.errorMessageKey = null;
    owner.completedPurchaseCount = 0;
    balance.balance = 1234;
  });

  it('happy: renders one row per pack with its amount and store price, purchase enabled', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => packRows(renderer).length === 4);

    const rows = packRows(renderer);
    expect(rows).toHaveLength(4);
    // The row is one accessible element, so the label carries the charge the
    // store sheet will show, not only the credit amount.
    expect(
      rows.map(row => (row.props as { accessibilityLabel: string }).accessibilityLabel)
    ).toEqual([
      'Add $10.00 of credits, $10.99',
      'Add $50.00 of credits, $54.99',
      'Add $100.00 of credits, $109.99',
      'Add $500.00 of credits, $549.99',
    ]);
    expect(allText(renderer)).toContain('Add $10.00 of credits');
    expect(allText(renderer)).toContain('Add $500.00 of credits');
    expect(allText(renderer)).toContain('$10.99');
    expect(allText(renderer)).toContain('$549.99');
    expect(rows.every(row => (row.props as { disabled?: boolean }).disabled === false)).toBe(true);
    expect(allText(renderer)).toContain('$1,234.00');
    expect(classNamesOf(rows).every(classes => classes.includes(PACK_ROW_SHELL))).toBe(true);
    const firstRow = rows[0];
    if (!firstRow) {
      throw new Error('expected four pack rows');
    }
    await act(async () => {
      (firstRow.props as { onPress?: () => void }).onPress?.();
      await Promise.resolve();
    });
    expect(owner.purchase).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('loading: renders skeleton rows sized like a pack row and no pack row', async () => {
    owner.connected = false;

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));

    expect(
      renderer.root.findAll(node => String(node.type) === 'Skeleton').length
    ).toBeGreaterThanOrEqual(4);
    expect(packRows(renderer)).toHaveLength(0);
    // The placeholders reserve the pack row's own shell and one-line content,
    // so the rows swap in without moving the legal copy below them.
    const shells = placeholderShells(renderer);
    expect(shells).toHaveLength(4);
    for (const shell of shells) {
      const bars = shell.findAll(node => String(node.type) === 'Skeleton');
      expect(bars).toHaveLength(2);
      expect(classNamesOf(bars).every(classes => classes.includes('h-6'))).toBe(true);
    }
    unmount();
  });

  it('retryable: shows the store banner and Try again keeps the pack rows', async () => {
    owner.fetchStoreProducts.mockRejectedValue(new Error('Failed to query product for sku'));

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => allText(renderer).includes('App Store products unavailable'));

    expect(packRows(renderer)).toHaveLength(4);
    expect(allText(renderer)).toContain('No matching credit packs were returned by App Store.');
    expect(allText(renderer)).toContain('Price unavailable');
    // The store SDK's own wording never reaches the screen.
    expect(allText(renderer)).not.toContain('Failed to query product');

    const retry = tryAgainButton(renderer);
    if (!retry) {
      throw new Error('expected a Try again button');
    }
    await act(async () => {
      (retry.props as { onPress?: () => void }).onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => owner.fetchStoreProducts.mock.calls.length >= 2);

    expect(packRows(renderer)).toHaveLength(4);
    expect(allText(renderer)).toContain('Price unavailable');
    unmount();
  });

  it('retry stays settled: the rows and banner survive while the retry is still pending', async () => {
    // The first store fetch fails, the second never answers: the retry stays in
    // flight, so the screen must keep the settled rows and banner instead of
    // dropping to the loading placeholders.
    owner.fetchStoreProducts.mockRejectedValueOnce(new Error('Failed to query product for sku'));
    owner.fetchStoreProducts.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- the retry never settles, which is the scenario under test
      () => new Promise<void>(() => undefined)
    );

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => allText(renderer).includes('App Store products unavailable'));
    expect(packRows(renderer)).toHaveLength(4);

    const retry = tryAgainButton(renderer);
    if (!retry) {
      throw new Error('expected a Try again button');
    }
    await act(async () => {
      (retry.props as { onPress?: () => void }).onPress?.();
      await Promise.resolve();
    });

    expect(owner.fetchStoreProducts.mock.calls.length).toBe(2);
    expect(packRows(renderer)).toHaveLength(4);
    expect(allText(renderer)).toContain('App Store products unavailable');
    expect(allText(renderer)).toContain('No matching credit packs were returned by App Store.');
    expect(allText(renderer)).toContain('Price unavailable');
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(0);
    // The button that started the retry stays on screen, busy and disabled.
    const pendingRetry = tryAgainButton(renderer);
    if (!pendingRetry) {
      throw new Error('expected the Try again button to stay on screen');
    }
    expect((pendingRetry.props as { disabled?: boolean }).disabled).toBe(true);
    unmount();
  });

  it('retry success: the rows gain their store prices and the banner clears', async () => {
    owner.fetchStoreProducts
      .mockRejectedValueOnce(new Error('Failed to query product for sku'))
      .mockResolvedValueOnce(STORE_LISTINGS);

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => allText(renderer).includes('App Store products unavailable'));

    const retry = tryAgainButton(renderer);
    if (!retry) {
      throw new Error('expected a Try again button');
    }
    await act(async () => {
      (retry.props as { onPress?: () => void }).onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => allText(renderer).includes('$10.99'));

    expect(allText(renderer)).not.toContain('App Store products unavailable');
    expect(packRows(renderer)).toHaveLength(4);
    unmount();
  });

  it('renders a pack the store did not price as disabled with the price-unavailable note', async () => {
    owner.fetchStoreProducts.mockResolvedValue(STORE_LISTINGS.slice(0, 3));

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => packRows(renderer).length === 4);

    const rows = packRows(renderer);
    expect(
      rows.filter(row => (row.props as { disabled?: boolean }).disabled === true)
    ).toHaveLength(1);
    // A user who cannot hear the price also hears why the row is unavailable.
    expect(
      rows.map(row => (row.props as { accessibilityLabel: string }).accessibilityLabel)
    ).toContain('Add $500.00 of credits, Price unavailable');
    expect(allText(renderer)).toContain('Price unavailable');
    unmount();
  });

  it('non-retryable: an account-mismatch error shows the mismatch copy, no retry, rows enabled', async () => {
    owner.errorMessageKey = 'credits.purchaseOwnedByAnotherAccount';

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => packRows(renderer).length === 4);

    expect(allText(renderer)).toContain(
      'The credits on this Apple Account belong to a different Kilo account. Sign in to that Kilo account to use them.'
    );
    expect(tryAgainButton(renderer)).toBeUndefined();
    expect(
      packRows(renderer).every(row => (row.props as { disabled?: boolean }).disabled === false)
    ).toBe(true);
    // The toast is suppressed for this screen, so the inline status is the only
    // remaining channel: on iOS AccessibleStatus announces it imperatively.
    expect(statusAnnouncement.useStatusAnnouncement).toHaveBeenCalledWith(
      'The credits on this Apple Account belong to a different Kilo account. Sign in to that Kilo account to use them.'
    );
    unmount();
  });

  it('announcement: the inline purchase error is a polite live region on Android', async () => {
    // Android has no imperative announcement for this status: the persistent
    // error text itself must be the live region TalkBack reads when it appears
    // after the store sheet dismisses.
    owner.errorMessageKey = 'credits.purchaseOwnedByAnotherAccount';
    mockedPlatform.OS = 'android';

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => packRows(renderer).length === 4);

    const status = renderer.root.findByType(AccessibleStatus);
    expect(status.props.message).toBe(
      'The credits on this Apple Account belong to a different Kilo account. Sign in to that Kilo account to use them.'
    );
    expect(status.findByType('Text').props.accessibilityLiveRegion).toBe('polite');
    unmount();
  });

  it('empty: an empty backend catalog shows credits.empty with no purchase CTA', async () => {
    backend.response = { appAccountToken: '550e8400-e29b-41d4-a716-446655440000', products: [] };

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => allText(renderer).includes('Credit packs are unavailable right now.'));

    expect(packRows(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
    unmount();
  });

  it('shows the completing copy and disables every row while a purchase is in flight', async () => {
    owner.completingProductId = 'credits.usd10.v1';

    const { renderer, unmount } = await renderWithProviders(createElement(CreditPurchaseScreen));
    await waitFor(() => packRows(renderer).length === 4);

    expect(allText(renderer)).toContain('Completing purchase');
    const rows = packRows(renderer);
    // The in-flight row announces its state in the label too.
    const busyRow = rows.find(
      row =>
        (row.props as { accessibilityState?: { busy?: boolean } }).accessibilityState?.busy === true
    );
    expect(
      (busyRow?.props as { accessibilityLabel?: string } | undefined)?.accessibilityLabel
    ).toBe('Add $10.00 of credits, Completing purchase');
    expect(
      rows.every(
        row =>
          (row.props as { disabled?: boolean }).disabled === true &&
          (row.props as { accessibilityState?: { disabled?: boolean } }).accessibilityState
            ?.disabled === true
      )
    ).toBe(true);
    unmount();
  });

  it('announces a granted purchase with the purchased toast and refreshes the balance', async () => {
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement(CreditPurchaseScreen)
    );
    await waitFor(() => packRows(renderer).length === 4);

    owner.completedPurchaseCount = 1;
    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CreditPurchaseScreen)
        )
      );
      await Promise.resolve();
    });

    expect(toastMock.success).toHaveBeenCalledWith('Credits added to your balance.');
    expect(packRows(renderer)).toHaveLength(4);
    unmount();
  });
});
