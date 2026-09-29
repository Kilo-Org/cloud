import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { resetStoreConnection, StorePurchaseRecoveryMount } from './store-purchase-recovery-mount';

const CREDIT_PRODUCT_ID = 'credits.usd10.v1';
const KILO_PASS_PRODUCT_ID = 'kilopass.pro.monthly';

const mockedIap = vi.hoisted(() => ({
  finishTransaction: vi.fn(),
  getPendingTransactionsIOS: vi.fn(),
  initConnection: vi.fn(),
}));

const mockedLifecycle = vi.hoisted(() => ({ isActive: true }));
const mockedAuth = vi.hoisted((): { token: string | null } => ({ token: 'session-token' }));

const mockedQuery = vi.hoisted(
  (): {
    catalogs: Record<string, unknown>;
    completions: { procedure: string; input: unknown }[];
    invalidateQueries: ReturnType<typeof vi.fn>;
  } => ({
    catalogs: {},
    completions: [],
    invalidateQueries: vi.fn(),
  })
);

vi.mock('expo-iap', () => ({
  // The flow modules build their error schemas from these codes at import time.
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    UserCancelled: 'user-cancelled',
  },
  finishTransaction: mockedIap.finishTransaction,
  getPendingTransactionsIOS: mockedIap.getPendingTransactionsIOS,
  initConnection: mockedIap.initConnection,
  requestPurchase: vi.fn(),
  restorePurchases: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('@/lib/hooks/use-app-lifecycle', () => ({
  useAppLifecycle: () => ({ isActive: mockedLifecycle.isActive }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: mockedAuth.token, isLoading: false, isSigningOut: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { procedure: string }) => ({
    mutateAsync: async (input: unknown) => {
      mockedQuery.completions.push({ procedure: options.procedure, input });
      await Promise.resolve();
      return {};
    },
  }),
  useQuery: (options: { procedure: string }) => ({
    data: mockedQuery.catalogs[options.procedure],
  }),
  useQueryClient: () => ({ invalidateQueries: mockedQuery.invalidateQueries }),
}));

// The flow modules raise their own toast for a purchase failure this pass never
// reports; the real library cannot load in this project.
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    credits: {
      completeAppStorePurchase: {
        mutationOptions: () => ({ procedure: 'credits.completeAppStorePurchase' }),
      },
      completePlayPurchase: {
        mutationOptions: () => ({ procedure: 'credits.completePlayPurchase' }),
      },
      getMobileStoreProducts: {
        queryOptions: () => ({ procedure: 'credits.getMobileStoreProducts' }),
      },
    },
    kiloPass: {
      completeAppStorePurchase: {
        mutationOptions: () => ({ procedure: 'kiloPass.completeAppStorePurchase' }),
      },
      completePlayPurchase: {
        mutationOptions: () => ({ procedure: 'kiloPass.completePlayPurchase' }),
      },
      getMobileStoreProducts: {
        queryOptions: () => ({ procedure: 'kiloPass.getMobileStoreProducts' }),
      },
      getState: { pathFilter: () => ({ queryKey: ['kilo-pass-state'] }) },
      getCreditHistory: { pathFilter: () => ({ queryKey: ['kilo-pass-history'] }) },
      getPurchasePresentation: { pathFilter: () => ({ queryKey: ['kilo-pass-presentation'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

const creditCatalog = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [{ appleProductId: CREDIT_PRODUCT_ID, googleProductId: 'credits_usd10' }],
};

const kiloPassCatalog = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilopass_pro_monthly' }],
};

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: false,
    productId: CREDIT_PRODUCT_ID,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function mountRecovery(): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(StorePurchaseRecoveryMount));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('StorePurchaseRecoveryMount did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

async function flushPromises() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers();
    setImmediate(resolve);
    await promise;
  });
}

/** Re-render so the pass sees the new app lifecycle state. */
async function rerender(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.update(createElement(StorePurchaseRecoveryMount));
    await Promise.resolve();
  });
}

function completionsNamed(procedure: string) {
  return mockedQuery.completions.filter(completion => completion.procedure === procedure);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoreConnection();
  mockedAuth.token = 'session-token';
  mockedLifecycle.isActive = true;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getPendingTransactionsIOS.mockResolvedValue([]);
  mockedIap.initConnection.mockResolvedValue(undefined);
  mockedQuery.catalogs = {
    'credits.getMobileStoreProducts': creditCatalog,
    'kiloPass.getMobileStoreProducts': kiloPassCatalog,
  };
  mockedQuery.completions = [];
  mockedQuery.invalidateQueries.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('StorePurchaseRecoveryMount', () => {
  it('grants and finishes an unfinished credit pack the backend never recorded', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([createPurchase()]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('credits.completeAppStorePurchase')).toEqual([
      { procedure: 'credits.completeAppStorePurchase', input: { signedTransactionJws: 'signed-jws' } },
    ]);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: CREDIT_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalled();
  });

  it('grants and finishes an unfinished Kilo Pass subscription', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({ productId: KILO_PASS_PRODUCT_ID, transactionId: 'tx-pass' }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(0);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: KILO_PASS_PRODUCT_ID }),
      isConsumable: false,
    });
  });

  it('leaves a pending transaction no catalog sells untouched', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({ productId: 'some.other.product' }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(mockedQuery.completions).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
  });

  it('does not disturb the store while signed out', async () => {
    mockedAuth.token = null;

    await mountRecovery();
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).not.toHaveBeenCalled();
    expect(mockedQuery.completions).toHaveLength(0);
  });

  it('gives up on a store call that never answers, and does not stay stuck', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const neverSettles = Promise.withResolvers();
    mockedIap.initConnection.mockReturnValue(neverSettles.promise);
    // Only the deadline is faked: the mount helpers await real microtasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const renderer = await mountRecovery();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);

      expect(warn).toHaveBeenCalledWith(
        '[iap-recovery] unfinished purchase pass failed',
        expect.stringContaining('did not answer')
      );
      expect(mockedQuery.completions).toHaveLength(0);

      // The in-flight guard must be released, or recovery is dead for the rest
      // of the process: the next foreground pass has to try again.
      mockedIap.initConnection.mockResolvedValue(undefined);
      mockedIap.getPendingTransactionsIOS.mockResolvedValue([createPurchase()]);
      mockedLifecycle.isActive = false;
      await rerender(renderer);
      mockedLifecycle.isActive = true;
      await rerender(renderer);
      await flushPromises();

      expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
      expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers again when the app returns to the foreground', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValueOnce([createPurchase()]);
    const renderer = await mountRecovery();
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);

    mockedLifecycle.isActive = false;
    await rerender(renderer);
    mockedLifecycle.isActive = true;
    await rerender(renderer);
    await flushPromises();

    // The background -> active edge runs one further pass, and the store now
    // answers with nothing left pending.
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
  });

  it('reports nothing on screen when the store cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedIap.getPendingTransactionsIOS.mockRejectedValue(new Error('store unreachable'));

    await mountRecovery();
    await flushPromises();

    expect(mockedQuery.completions).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    // The message is logged as text on purpose: a device log keeps the reason a
    // charge never credited, where a bare Error object stringifies to nothing.
    expect(warn).toHaveBeenCalledWith(
      '[iap-recovery] unfinished purchase pass failed',
      expect.stringContaining('store unreachable')
    );
  });
});
