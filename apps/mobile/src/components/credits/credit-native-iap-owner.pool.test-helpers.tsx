import { createElement } from 'react';
import { type Purchase, type RequestPurchaseProps, type RequestPurchaseResult } from 'expo-iap';
import { type Mock, vi } from 'vitest';

import { resetCreditPurchaseAuthorityForTests } from '@/lib/credits/credit-purchase-authority';
import { resetCreditPurchaseIntentForTests } from '@/lib/credits/credit-purchase-intent';
import { type StoreCreditProduct } from '@/lib/credits/store-products';
import { act, TestRenderer } from '@/test/renderer';
import {
  type CreditNativeIapContextValue,
  CreditNativeIapOwner,
  useCreditNativeIap,
} from './credit-native-iap-owner';

type PurchaseCallbacks = {
  onPurchaseSuccess?: (purchase: Purchase) => void;
  onPurchaseError?: (error: unknown) => void;
};
type NativePromise = {
  resolve: (purchase: RequestPurchaseResult) => void;
  reject: (error: unknown) => void;
};
type StoreFake = {
  callbacks: PurchaseCallbacks | null;
  pending: Set<NativePromise>;
  storage: Map<string, string>;
  requestPurchase: Mock<(request: RequestPurchaseProps) => Promise<RequestPurchaseResult>>;
  finishTransaction: Mock;
  lookup: Mock;
  complete: Mock;
  invalidate: Mock;
};
const nativeWorld = vi.hoisted((): StoreFake => ({
  callbacks: null,
  pending: new Set(),
  storage: new Map(),
  requestPurchase: vi.fn(),
  finishTransaction: vi.fn(),
  lookup: vi.fn(),
  complete: vi.fn(),
  invalidate: vi.fn(),
}));
export const store = nativeWorld;

vi.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => {
    sequence += 1;
    return `pooled-intent-${String(sequence)}`;
  } };
});
vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    DeferredPayment: 'deferred-payment',
    NotPrepared: 'not-prepared',
    Pending: 'pending',
    UserCancelled: 'user-cancelled',
  },
  fetchProducts: vi.fn().mockResolvedValue([]),
  useIAP: (callbacks: PurchaseCallbacks) => {
    store.callbacks = callbacks;
    return {
      connected: false,
      finishTransaction: store.finishTransaction,
      reconnect: vi.fn().mockResolvedValue(true),
      requestPurchase: store.requestPurchase,
    };
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/lib/iap/pending-store-purchases', () => ({ fetchPendingStorePurchases: nativeWorld.lookup }));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, key: string) => {
    await Promise.resolve();
    return store.storage.get(`${scope}:${key}`) ?? null;
  },
  setItem: async (scope: string, key: string, value: string) => {
    store.storage.set(`${scope}:${key}`, value);
    await Promise.resolve();
  },
  removeItemIfValue: async (scope: string, key: string, value: string) => {
    await Promise.resolve();
    return store.storage.get(`${scope}:${key}`) === value && store.storage.delete(`${scope}:${key}`);
  },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: store.complete }),
  useQuery: () => ({ data: {
    appAccountToken: 'pooled-fake-account',
    products: [{ appleProductId: 'credits.fake.apple', googleProductId: 'credits_fake_play' }],
  } }),
  useQueryClient: () => ({ invalidateQueries: store.invalidate }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    credits: {
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      completePlayPurchase: { mutationOptions: () => ({}) },
      getMobileStoreProducts: { queryOptions: () => ({}) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

export const pack: StoreCreditProduct = {
  backend: { amountUsd: 10, appleProductId: 'credits.fake.apple', googleProductId: 'credits_fake_play' },
  storeProductId: 'credits_fake_play',
  displayPrice: '$10',
};
export function nativePurchase(transactionId: string): Purchase {
  return {
    id: transactionId,
    transactionId,
    productId: 'credits_fake_play',
    store: 'google',
    storeId: 'play',
    purchaseState: 'purchased',
    purchaseToken: `token-${transactionId}`,
    transactionDate: Date.now(),
    isAutoRenewing: false,
    quantity: 1,
  };
}
export function emitNativePurchase(purchase: Purchase): void {
  store.callbacks?.onPurchaseSuccess?.(purchase);
  for (const request of store.pending) {
    request.resolve([purchase]);
  }
  store.pending.clear();
}
export function emitNativeError(error: unknown): void {
  store.callbacks?.onPurchaseError?.(error);
  for (const request of store.pending) {
    request.reject(error);
  }
  store.pending.clear();
}

export function resetPool(): void {
  vi.clearAllMocks();
  store.storage.clear();
  store.pending.clear();
  resetCreditPurchaseIntentForTests();
  resetCreditPurchaseAuthorityForTests();
  store.callbacks = null;
  store.lookup.mockResolvedValue([]);
  store.complete.mockResolvedValue({ alreadyProcessed: false });
  store.finishTransaction.mockResolvedValue(undefined);
  store.invalidate.mockResolvedValue(undefined);
  store.requestPurchase.mockImplementation(async () => {
    const pending = Promise.withResolvers<RequestPurchaseResult>();
    store.pending.add(pending);
    const result = await pending.promise;
    return result;
  });
}

type Handle = { value: CreditNativeIapContextValue | null };
export type PoolOwner = { handle: Handle; renderer: TestRenderer.ReactTestRenderer };
const mounted = new Set<TestRenderer.ReactTestRenderer>();
function Probe({ handle }: { handle: Handle }) {
  handle.value = useCreditNativeIap();
  return null;
}
export async function mountPoolOwner(): Promise<PoolOwner> {
  const handle: Handle = { value: null };
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    holder.renderer = TestRenderer.create(createElement(CreditNativeIapOwner, null, createElement(Probe, { handle })));
    await Promise.resolve();
  });
  if (!holder.renderer) {
    throw new Error('The pooled-purchase owner did not mount.');
  }
  mounted.add(holder.renderer);
  return { handle, renderer: holder.renderer };
}
export function ownerValue(owner: PoolOwner): CreditNativeIapContextValue {
  if (owner.handle.value === null) {
    throw new Error('The pooled-purchase owner has no context.');
  }
  return owner.handle.value;
}
export async function flushPool(): Promise<void> {
  await act(async () => {
    const turn = Promise.withResolvers<undefined>();
    setImmediate(() => { turn.resolve(undefined); });
    await turn.promise;
  });
}
export async function closePoolOwners(): Promise<void> {
  await act(async () => {
    for (const renderer of mounted) {
      renderer.unmount();
    }
    mounted.clear();
    emitNativeError({ code: 'service-disconnected' });
    await Promise.resolve();
  });
  await flushPool();
  vi.useRealTimers();
}
