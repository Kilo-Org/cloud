/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
/* eslint-disable max-lines -- the test file covers all four feature states plus owner-mount assertions */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';

// ── Mutable state ────────────────────────────────────────────────────

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));

const mocks = vi.hoisted(() => ({
  presentation: {
    isPending: false,
    isError: false,
    data: null as { kind: string; webUrl: string | null } | null,
    refetch: vi.fn(),
  },
  preflightMutateAsync: vi.fn(),
  preflightIsPending: false,
  ownerMount: vi.fn(),
  nativeIap: {
    clearError: vi.fn(),
    errorMessage: null as string | null,
    isPending: false,
    products: [] as unknown[],
    productsError: null as string | null,
    productsIsLoading: false,
    productsIsRefetching: false,
    productsRefetch: vi.fn(),
    purchase: vi.fn(),
  },
  routerPush: vi.fn(),
}));

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: mockedPlatform,
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: mocks.preflightMutateAsync,
    isPending: mocks.preflightIsPending,
  }),
  useQuery: () => mocks.presentation,
}));

vi.mock('@/components/detail-screen', () => ({
  DetailScreenScrollView: 'DetailScreenScrollView',
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

vi.mock('@/lib/external-link', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#6F6A61',
    primaryForeground: '#FFFFFF',
  }),
}));

vi.mock('@/lib/kilo-pass/legal-links', () => ({
  getKiloPassLegalLinks: () => [
    { url: 'https://example.com/privacy', label: 'Privacy Policy' },
    { url: 'https://example.com/terms', label: 'Terms of Use' },
  ],
  KILO_PASS_LEGAL_DISCLOSURE: '',
}));

vi.mock('@/lib/kilo-pass/navigation', () => ({
  ensureProfileAfterKiloPassPurchase: vi.fn(),
}));

vi.mock('@/lib/kilo-pass/subscription-page-copy', () => ({
  formatKiloPassTierDescription: () => 'description',
  KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION: '',
}));

vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  useInlinePurchaseErrorOwnership: () => undefined,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getPurchasePresentation: { queryOptions: () => ({}) },
      preflightPurchase: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(arg => typeof arg === 'string').join(' '),
}));

vi.mock('@kilocode/app-shared/commerce', () => ({
  KILO_PASS_MANAGE_CTA_LABEL: 'Manage',
  KILO_PASS_TITLE: 'Kilo Pass',
  KILO_PASS_UNAVAILABLE_DESCRIPTION:
    'Kilo Pass is not available as an in-app purchase on Android. Manage it on the web.',
  KILO_PASS_WEB_MANAGEMENT_DESCRIPTION: 'This Kilo Pass is managed on the web.',
}));

// The owner is the single `useIAP` call site (plan assumption 8). The mock
// records mounts so the screen test can assert the owner is not mounted for
// non-native / Android presentations, which means `useIAP` is never invoked.
vi.mock('./kilo-pass-native-iap-owner', () => ({
  KiloPassNativeIapOwner: ({ children }: { children: unknown }) => {
    mocks.ownerMount();
    return children;
  },
  useKiloPassNativeIap: () => mocks.nativeIap,
}));

vi.mock('./restore-purchases-button', () => ({
  RestorePurchasesButton: 'RestorePurchasesButton',
}));

// ── Fixtures and helpers ─────────────────────────────────────────────

const product = {
  appleProductId: 'com.kilo.pass.tier49.monthly',
  webMonthlyPriceUsd: 49,
  displayPrice: '$49.99',
};

async function flush(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('Expected at least one item');
  }
  return item;
}

function ignoreDeferredResolution(_value: unknown): void {
  return undefined;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = ignoreDeferredResolution;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(KiloPassSubscriptionScreen));
    await flush();
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function productTiles(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'Pressable' &&
      typeof (node.props as Record<string, unknown>).accessibilityLabel === 'string' &&
      ((node.props as Record<string, unknown>).accessibilityLabel as string).includes('in credits')
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

async function press(node: TestRenderer.ReactTestInstance): Promise<void> {
  await act(async () => {
    (node.props as { onPress?: () => void }).onPress?.();
    await flush();
  });
}

function setNativeIapPresentation(): void {
  mockedPlatform.OS = 'ios';
  mocks.presentation.data = { kind: 'native_iap', webUrl: null };
  mocks.nativeIap.productsIsLoading = false;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('KiloPassSubscriptionScreen', () => {
  beforeEach(() => {
    mockedPlatform.OS = 'ios';
    mocks.presentation.isPending = false;
    mocks.presentation.isError = false;
    mocks.presentation.data = null;
    mocks.preflightMutateAsync.mockReset();
    mocks.preflightIsPending = false;
    mocks.ownerMount.mockReset();
    mocks.nativeIap.clearError.mockReset();
    mocks.nativeIap.errorMessage = null;
    mocks.nativeIap.isPending = false;
    mocks.nativeIap.products = [];
    mocks.nativeIap.productsError = null;
    mocks.nativeIap.productsIsLoading = false;
    mocks.nativeIap.productsIsRefetching = false;
    mocks.nativeIap.productsRefetch.mockReset();
    mocks.nativeIap.purchase.mockReset();
    mocks.routerPush.mockReset();
  });

  it('happy: native_iap with products and an allowed preflight enables tiles and starts purchase', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [product];
    mocks.preflightMutateAsync.mockResolvedValue({
      allowed: true,
      statusClass: 'healthy',
      reason: null,
    });

    const renderer = await renderScreen();
    const tiles = productTiles(renderer);
    expect(tiles).toHaveLength(1);
    expect((first(tiles).props as { disabled?: boolean }).disabled).toBe(false);

    await press(first(tiles));

    expect(mocks.preflightMutateAsync).toHaveBeenCalledWith({
      platform: 'ios',
      storefront: 'app_store',
      product: 'kilo_pass',
      appleProductId: product.appleProductId,
    });
    expect(mocks.nativeIap.purchase).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('retryable: a transient preflight failure shows Try again and does not start IAP', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [product];
    mocks.preflightMutateAsync.mockRejectedValue(new Error('Network request failed'));

    const renderer = await renderScreen();
    const tiles = productTiles(renderer);
    await press(first(tiles));

    expect(mocks.nativeIap.purchase).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      "Couldn't verify your purchase. Check your connection and try again."
    );
    expect(allText(renderer)).toContain('Try again');

    const retryButton = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        (node.props as Record<string, unknown>).accessibilityLabel ===
          'Try verifying purchase again'
    );
    await press(retryButton);

    expect(mocks.preflightMutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.nativeIap.purchase).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('non-retryable: an allowed:false preflight disables the tiles and shows a terminal message', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [product];
    mocks.preflightMutateAsync.mockResolvedValue({
      allowed: false,
      statusClass: 'terminal',
      reason: 'already_subscribed',
    });

    const renderer = await renderScreen();
    const tiles = productTiles(renderer);
    await press(first(tiles));

    expect(mocks.nativeIap.purchase).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain('You already have a Kilo Pass subscription.');
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Button' &&
          (node.props as Record<string, unknown>).accessibilityLabel ===
            'Try verifying purchase again'
      )
    ).toHaveLength(0);

    const tilesAfter = productTiles(renderer);
    expect((first(tilesAfter).props as { disabled?: boolean }).disabled).toBe(true);
    expect(
      (first(tilesAfter).props as { accessibilityState?: { disabled?: boolean } })
        .accessibilityState?.disabled
    ).toBe(true);

    renderer.unmount();
  });

  it('non-retryable presentation: unavailable shows the unavailable screen with no purchase CTA', async () => {
    mockedPlatform.OS = 'ios';
    mocks.presentation.data = { kind: 'unavailable', webUrl: null };

    const renderer = await renderScreen();

    expect(allText(renderer)).toContain(
      'Kilo Pass is not available as an in-app purchase on Android. Manage it on the web.'
    );
    expect(productTiles(renderer)).toHaveLength(0);
    expect(
      renderer.root.findAll(node => String(node.type) === 'RestorePurchasesButton')
    ).toHaveLength(0);
    expect(mocks.ownerMount).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('non-retryable presentation: web_management shows Manage and no purchase CTA', async () => {
    mockedPlatform.OS = 'android';
    mocks.presentation.data = {
      kind: 'web_management',
      webUrl: 'https://example.com/subscriptions/kilo-pass',
    };

    const renderer = await renderScreen();

    expect(allText(renderer)).toContain('This Kilo Pass is managed on the web.');
    expect(allText(renderer)).toContain('Manage');
    expect(productTiles(renderer)).toHaveLength(0);
    expect(mocks.ownerMount).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('empty: native_iap with zero products shows App Store products unavailable', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [];

    const renderer = await renderScreen();

    expect(allText(renderer)).toContain('App Store products unavailable');
    expect(allText(renderer)).toContain('Try again');
    expect(productTiles(renderer)).toHaveLength(0);

    const retryButton = renderer.root.find(
      node =>
        String(node.type) === 'Pressable' &&
        (node.props as Record<string, unknown>).accessibilityLabel ===
          'Try loading Kilo Pass products again'
    );
    await press(retryButton);

    expect(mocks.nativeIap.productsRefetch).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not mount the IAP owner (single useIAP call site) on Android', async () => {
    mockedPlatform.OS = 'android';
    mocks.presentation.data = { kind: 'unavailable', webUrl: null };

    const renderer = await renderScreen();

    expect(mocks.ownerMount).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('mounts the IAP owner only for native_iap on iOS', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [];

    const renderer = await renderScreen();

    expect(mocks.ownerMount).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('disables the product tiles while preflight is pending', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [product];
    mocks.preflightIsPending = true;

    const renderer = await renderScreen();
    const tiles = productTiles(renderer);

    expect((first(tiles).props as { disabled?: boolean }).disabled).toBe(true);
    expect(
      (first(tiles).props as { accessibilityState?: { busy?: boolean; disabled?: boolean } })
        .accessibilityState?.busy
    ).toBe(true);
    expect(
      (first(tiles).props as { accessibilityState?: { disabled?: boolean } }).accessibilityState
        ?.disabled
    ).toBe(true);

    renderer.unmount();
  });

  it('does not start the purchase when the screen unmounts during preflight', async () => {
    setNativeIapPresentation();
    mocks.nativeIap.products = [product];
    const deferred = createDeferred<unknown>();
    mocks.preflightMutateAsync.mockReturnValue(deferred.promise);

    const renderer = await renderScreen();
    const tiles = productTiles(renderer);
    act(() => {
      (first(tiles).props as { onPress?: () => void }).onPress?.();
    });

    act(() => {
      renderer.unmount();
    });

    await act(async () => {
      deferred.resolve({ allowed: true, statusClass: 'healthy', reason: null });
      await flush();
    });

    expect(mocks.nativeIap.purchase).not.toHaveBeenCalled();
  });
});
