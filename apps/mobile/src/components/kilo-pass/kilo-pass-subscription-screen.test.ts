/* eslint-disable max-lines -- Covers read-only states, provider/platform pairings, and store management without sales or steering. */
import { createElement } from 'react';
import { type Purchase, type PurchaseIOS } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';
import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  state: { data: undefined as unknown, isPending: false, isError: false, refetch: vi.fn() },
  catalog: {
    data: {
      products: [] as { tier: string; googleProductId: string }[],
      appAccountToken: undefined as string | undefined,
    },
    isPending: false,
    isError: false,
  },
  native: { data: [] as Purchase[] },
  invalidate: vi.fn(),
  appleManagement: vi.fn(),
  playManagement: vi.fn(),
  externalLink: vi.fn(),
  requestPurchase: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform, View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: object) => (args ? `${key} ${JSON.stringify(args)}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/i18n', () => ({
  i18n: {
    language: 'en',
    t: (key: string, args?: object) => (args ? `${key} ${JSON.stringify(args)}` : key),
  },
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({ getResolvedLanguage: () => 'en' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('./restore-purchases-button', () => ({ RestorePurchasesButton: 'RestorePurchasesButton' }));
vi.mock('./kilo-pass-ios-manage', () => ({ openAppStoreManagement: mocks.appleManagement }));
vi.mock('./kilo-pass-play-manage', () => ({
  openPlaySubscriptionManagement: mocks.playManagement,
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: mocks.externalLink }));
vi.mock('expo-iap', () => ({
  requestPurchase: mocks.requestPurchase,
  initConnection: vi.fn(),
  getAvailablePurchases: vi.fn(),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'session', isLoading: false, isSigningOut: false }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getState: {
        queryOptions: () => ({ name: 'state' }),
        pathFilter: () => ({ queryKey: ['state'] }),
      },
      getMobileStoreProducts: { queryOptions: () => ({ name: 'catalog' }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { name?: string }) => {
    if (options.name === 'state') {
      return mocks.state;
    }
    if (options.name === 'catalog') {
      return mocks.catalog;
    }
    return mocks.native;
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));

const active = {
  status: 'active',
  cancelAtPeriodEnd: false,
  paymentProvider: 'app_store',
  tier: 'tier_19',
  cadence: 'monthly',
  currentPeriodBaseCreditsUsd: 19,
  currentStreakMonths: 4,
  nextBillingAt: '2026-11-08T12:00:00.000Z',
  refillAt: '2026-10-09T12:00:00.000Z',
  currentPeriodBonus: { status: 'issued', actualAmountUsd: 1.9, projectedAmountUsd: null },
};
const renderers: TestRenderer.ReactTestRenderer[] = [];
async function renderScreen() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(KiloPassSubscriptionScreen));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  renderers.push(renderer);
  return renderer;
}
function text(renderer: TestRenderer.ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}
function manageButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(
        child => Object.is(child.type, 'Text') && child.props.children === 'kiloPass.manage'
      ).length > 0
  );
}

function ownedApple(overrides: Partial<PurchaseIOS> = {}): PurchaseIOS {
  return {
    id: 'legacy',
    productId: 'kilopass.tier19.monthly.v1',
    store: 'apple',
    purchaseState: 'purchased',
    purchaseToken: 'jws',
    quantity: 1,
    transactionDate: Date.now(),
    transactionId: 'legacy-transaction',
    isAutoRenewing: false,
    appAccountToken: 'account-a',
    expirationDateIOS: Date.now() + 60_000,
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
  mocks.state.data = { subscription: active };
  mocks.state.isPending = false;
  mocks.state.isError = false;
  mocks.catalog.data = { products: [], appAccountToken: 'account-a' };
  mocks.catalog.isPending = false;
  mocks.catalog.isError = false;
  mocks.native.data = [];
});
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

describe('read-only Kilo Pass status', () => {
  it('shows status, paid expiry, streak, and issued bonus without sale controls', async () => {
    const renderer = await renderScreen();
    const content = text(renderer);
    expect(content).toContain('kiloPass.statusActive');
    expect(content).toContain('kiloPass.paidThrough');
    expect(content).toContain('kiloPass.streakMonths');
    expect(content).toContain('kiloPass.bonusIssued');
    expect(content).not.toContain('kiloPass.subscribe');
    expect(content).not.toContain('kiloPass.legalDisclosure');
    expect(content).not.toContain('kiloPass.tierDescription');
    expect(mocks.requestPurchase).not.toHaveBeenCalled();
    expect(mocks.externalLink).not.toHaveBeenCalled();
  });

  it.each([
    ['ios', 'loading'],
    ['ios', 'error'],
    ['ios', 'empty'],
    ['android', 'loading'],
    ['android', 'error'],
    ['android', 'empty'],
  ])('keeps restoration reachable on %s in the %s state', async (platform, kind) => {
    mocks.platform.OS = platform;
    mocks.state.isPending = kind === 'loading';
    mocks.state.isError = kind === 'error';
    mocks.state.data = { subscription: null };
    const renderer = await renderScreen();
    expect(
      renderer.root.findAll(node => Object.is(node.type, 'RestorePurchasesButton'))
    ).toHaveLength(1);
    expect(manageButtons(renderer)).toHaveLength(0);
  });

  it('retries a failed status request', async () => {
    mocks.state.isError = true;
    const renderer = await renderScreen();
    const retry = renderer.root.findByProps({ accessibilityLabel: 'kiloPass.retryLoading' });
    const { onPress } = retry.props as { onPress: () => void };
    act(() => {
      onPress();
    });
    expect(mocks.state.refetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ios', 'android'])(
    'shows existing Stripe state on %s without a website link',
    async platform => {
      mocks.platform.OS = platform;
      mocks.state.data = { subscription: { ...active, paymentProvider: 'stripe' } };
      const renderer = await renderScreen();
      expect(text(renderer)).toContain('kiloPass.managedOnWeb');
      expect(text(renderer)).toContain('kiloPass.statusActive');
      expect(text(renderer)).toContain('kiloPass.streakMonths');
      expect(manageButtons(renderer)).toHaveLength(0);
      expect(mocks.externalLink).not.toHaveBeenCalled();
    }
  );

  it('keeps owned paid Apple management reachable when Stripe is primary', async () => {
    mocks.state.data = { subscription: { ...active, paymentProvider: 'stripe' } };
    mocks.native.data = [ownedApple({ appAccountToken: 'ACCOUNT-A' })];
    const renderer = await renderScreen();
    expect(text(renderer)).toContain('kiloPass.managedOnWeb');
    expect(manageButtons(renderer)).toHaveLength(1);
    expect(mocks.externalLink).not.toHaveBeenCalled();
  });

  it.each([
    { appAccountToken: 'another-account' },
    { appAccountToken: null },
    { expirationDateIOS: Date.now() - 1 },
    { expirationDateIOS: null },
    { purchaseState: 'pending' as const },
    { productId: 'credits.usd10' },
  ])('does not manage an unowned or unpaid Apple receipt: %o', async overrides => {
    mocks.state.data = { subscription: { ...active, paymentProvider: 'stripe' } };
    mocks.native.data = [ownedApple(overrides)];
    expect(manageButtons(await renderScreen())).toHaveLength(0);
  });

  it('keeps management reachable for an owned active receipt before backend recovery succeeds', async () => {
    mocks.state.data = { subscription: null };
    mocks.native.data = [ownedApple()];
    expect(manageButtons(await renderScreen())).toHaveLength(1);
  });

  it('uses the owned Play product, not the primary web tier, after native renewal stops', async () => {
    mocks.platform.OS = 'android';
    mocks.state.data = { subscription: { ...active, tier: 'tier_49', paymentProvider: 'stripe' } };
    mocks.native.data = [
      {
        id: 'legacy-play',
        productId: 'kilopass_tier19',
        store: 'google',
        purchaseState: 'purchased',
        purchaseToken: 'token',
        quantity: 1,
        transactionDate: Date.now(),
        isAutoRenewing: false,
        autoRenewingAndroid: false,
        obfuscatedAccountIdAndroid: 'account-a',
      },
    ];
    const renderer = await renderScreen();
    expect(text(renderer)).toContain('kiloPass.managedOnWeb');
    expect(text(renderer)).toContain('kiloPass.managedOnGooglePlay');
    const props = manageButtons(renderer)[0]?.props as { onPress: () => void } | undefined;
    if (!props) {
      throw new Error('Missing owned native management');
    }
    await act(async () => {
      props.onPress();
      const gate = Promise.withResolvers<undefined>();
      setImmediate(gate.resolve, undefined);
      await gate.promise;
    });
    expect(mocks.playManagement).toHaveBeenCalledWith({
      skuAndroid: 'kilopass_tier19',
      invalidateAfter: expect.any(Function),
    });
    expect(mocks.externalLink).not.toHaveBeenCalled();
  });

  it.each([
    { obfuscatedAccountIdAndroid: 'another-account' },
    { obfuscatedAccountIdAndroid: null },
    { purchaseState: 'pending' as const },
    { isSuspendedAndroid: true },
    { productId: 'credits_usd10' },
  ])('does not manage an unowned or unpaid Play receipt: %o', async overrides => {
    mocks.platform.OS = 'android';
    mocks.state.data = { subscription: { ...active, paymentProvider: 'stripe' } };
    mocks.native.data = [
      {
        id: 'legacy-play',
        productId: 'kilopass_tier19',
        store: 'google',
        purchaseState: 'purchased',
        purchaseToken: 'token',
        quantity: 1,
        transactionDate: Date.now(),
        isAutoRenewing: false,
        obfuscatedAccountIdAndroid: 'account-a',
        ...overrides,
      },
    ];
    expect(manageButtons(await renderScreen())).toHaveLength(0);
  });

  it('shows canceled-but-unexpired paid benefits and native management', async () => {
    mocks.state.data = { subscription: { ...active, cancelAtPeriodEnd: true } };
    const renderer = await renderScreen();
    expect(text(renderer)).toContain('kiloPass.statusCanceling');
    expect(text(renderer)).toContain('kiloPass.paidThrough');
    expect(manageButtons(renderer)).toHaveLength(1);
  });

  it.each(['canceled', 'incomplete_expired'])(
    'shows ended %s state without management or fabricated expiry',
    async status => {
      mocks.state.data = { subscription: { ...active, status, nextBillingAt: null } };
      const renderer = await renderScreen();
      expect(text(renderer)).toContain('organization.kiloPass.ended');
      expect(text(renderer)).not.toContain('kiloPass.paidThrough');
      expect(manageButtons(renderer)).toHaveLength(0);
    }
  );

  it.each([
    ['incomplete', 'kiloPass.statusPending'],
    ['past_due', 'kiloPass.statusPastDue'],
    ['unpaid', 'kiloPass.statusPastDue'],
    ['paused', 'kiloPass.statusPaused'],
  ])('shows %s accurately', async (status, label) => {
    mocks.state.data = { subscription: { ...active, status } };
    expect(text(await renderScreen())).toContain(label);
  });

  it('shows available bonus without treating it as issued', async () => {
    mocks.state.data = {
      subscription: {
        ...active,
        currentPeriodBonus: { status: 'available', projectedAmountUsd: 1.9, actualAmountUsd: null },
      },
    };
    const content = text(await renderScreen());
    expect(content).toContain('kiloPass.bonusAvailable');
    expect(content).not.toContain('kiloPass.bonusIssued');
  });

  it.each([
    ['ios', 'google_play'],
    ['android', 'app_store'],
  ])('does not open the other platform store on %s', async (platform, paymentProvider) => {
    mocks.platform.OS = platform;
    mocks.state.data = { subscription: { ...active, paymentProvider } };
    expect(manageButtons(await renderScreen())).toHaveLength(0);
  });

  it('opens Apple management without a sale catalog', async () => {
    mocks.catalog.isError = true;
    const renderer = await renderScreen();
    const props = manageButtons(renderer)[0]?.props as { onPress: () => void } | undefined;
    if (!props) {
      throw new Error('Missing store management action');
    }
    const { onPress } = props;
    await act(async () => {
      onPress();
      await Promise.resolve();
    });
    expect(mocks.appleManagement).toHaveBeenCalledWith({ invalidateAfter: expect.any(Function) });
  });

  it('opens Play management even with no sale-enabled identifiers', async () => {
    mocks.platform.OS = 'android';
    mocks.state.data = { subscription: { ...active, paymentProvider: 'google_play' } };
    mocks.catalog.isError = true;
    const renderer = await renderScreen();
    const props = manageButtons(renderer)[0]?.props as { onPress: () => void } | undefined;
    if (!props) {
      throw new Error('Missing store management action');
    }
    const { onPress } = props;
    await act(async () => {
      onPress();
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setImmediate(resolve, undefined);
      await promise;
    });
    expect(mocks.playManagement).toHaveBeenCalledWith({ invalidateAfter: expect.any(Function) });
    expect(mocks.requestPurchase).not.toHaveBeenCalled();
  });
});
