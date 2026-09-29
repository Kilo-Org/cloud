import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { type Mock, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { StorePurchaseRecoveryMount } from './store-purchase-recovery-mount';

export const CREDIT_PRODUCT_ID = 'credits.usd10.v1';
export const KILO_PASS_PRODUCT_ID = 'kilopass.pro.monthly';

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
    invalidateQueries: Mock;
  } => ({
    catalogs: {},
    completions: [],
    invalidateQueries: vi.fn(),
  })
);

export { mockedIap, mockedLifecycle, mockedAuth, mockedQuery };

vi.mock('expo-iap', () => ({
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

export const creditCatalog = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [{ appleProductId: CREDIT_PRODUCT_ID, googleProductId: 'credits_usd10' }],
};

export const kiloPassCatalog = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilopass_pro_monthly' }],
};

export function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
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

export const mounted: TestRenderer.ReactTestRenderer[] = [];

export async function mountRecovery(): Promise<TestRenderer.ReactTestRenderer> {
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

export async function flushPromises() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers();
    setImmediate(resolve);
    await promise;
  });
}

export async function rerender(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.update(createElement(StorePurchaseRecoveryMount));
    await Promise.resolve();
  });
}

export function completionsNamed(procedure: string) {
  return mockedQuery.completions.filter(completion => completion.procedure === procedure);
}
