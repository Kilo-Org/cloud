/* eslint-disable max-lines -- Covers read-only states, provider/platform pairings, and store management without sales or steering. */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';
import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  state: { data: undefined as unknown, isPending: false, isError: false, refetch: vi.fn() },
  catalog: {
    data: { products: [] as { tier: string; googleProductId: string }[] },
    isPending: false,
    isError: false,
  },
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
vi.mock('expo-iap', () => ({ requestPurchase: mocks.requestPurchase }));
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
  useQuery: (options: { name: string }) => (options.name === 'state' ? mocks.state : mocks.catalog),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
  mocks.state.data = { subscription: active };
  mocks.state.isPending = false;
  mocks.state.isError = false;
  mocks.catalog.data = { products: [] };
  mocks.catalog.isPending = false;
  mocks.catalog.isError = false;
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
