import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  type StoreKiloPassRecovery,
  useStoreKiloPassRecovery,
} from './use-store-kilo-pass-recovery';

const mocks = vi.hoisted(() => ({
  token: 'session' as string | null,
  connect: vi.fn(),
  available: vi.fn(),
  restore: vi.fn(),
  finish: vi.fn(),
  backend: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('expo-iap', () => ({
  ErrorCode: {
    UserCancelled: 'user-cancelled',
    Pending: 'pending',
    DeferredPayment: 'deferred-payment',
  },
  initConnection: mocks.connect,
  getAvailablePurchases: mocks.available,
  restorePurchases: mocks.restore,
  finishTransaction: mocks.finish,
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: mocks.token, isLoading: false, isSigningOut: false }),
}));
vi.mock('@/lib/credits/storefront', () => ({ getCreditStorefront: () => 'app_store' }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { appAccountToken: 'account-a', products: [] } }),
  useMutation: () => ({ mutateAsync: mocks.backend }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getMobileStoreProducts: { queryOptions: () => ({ queryKey: ['catalog'] }) },
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      completePlayPurchase: { mutationOptions: () => ({}) },
      getState: { pathFilter: () => ({ queryKey: ['state'] }) },
      getCreditHistory: { pathFilter: () => ({ queryKey: ['history'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

const legacyPurchase = {
  id: 'legacy',
  ids: null,
  isAutoRenewing: false,
  productId: 'kilopass.tier19.monthly.v1',
  purchaseState: 'purchased',
  purchaseToken: 'verified-jws',
  quantity: 1,
  store: 'apple',
  transactionDate: Date.now(),
  transactionId: 'legacy-transaction',
} satisfies Purchase;

type RecoveryHandle = { current: StoreKiloPassRecovery | null };
function Probe({ handle }: { handle: RecoveryHandle }) {
  handle.current = useStoreKiloPassRecovery();
  return null;
}
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mountRecovery() {
  const handle: RecoveryHandle = { current: null };
  await act(async () => {
    await Promise.resolve();
    mounted.push(TestRenderer.create(createElement(Probe, { handle })));
  });
  return handle;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = 'session';
  mocks.connect.mockResolvedValue(true);
  mocks.available.mockResolvedValue([legacyPurchase]);
  mocks.restore.mockResolvedValue(undefined);
  mocks.backend.mockResolvedValue({ alreadyProcessed: false });
  mocks.finish.mockResolvedValue(undefined);
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
  vi.useRealTimers();
});

describe('explicit legacy subscription recovery', () => {
  it('reconnects and restores retired IDs without fetching products or requesting purchases', async () => {
    const handle = await mountRecovery();
    await act(async () => {
      expect(await handle.current?.restorePurchases()).toBe('restored');
    });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.backend).toHaveBeenCalledWith({
      signedTransactionJws: 'verified-jws',
      platform: 'ios',
      storefront: 'app_store',
      product: 'kilo_pass',
    });
    expect(mocks.finish).toHaveBeenCalledWith({ purchase: legacyPurchase, isConsumable: false });
  });

  it('returns empty without finishing when no legacy purchases exist', async () => {
    mocks.available.mockResolvedValue([]);
    const handle = await mountRecovery();
    await act(async () => {
      expect(await handle.current?.restorePurchases()).toBe('empty');
    });
    expect(mocks.backend).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('refuses explicit restoration while signed out', async () => {
    mocks.token = null;
    const handle = await mountRecovery();
    await act(async () => {
      expect(await handle.current?.restorePurchases()).toBe(null);
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('releases the busy state after a connection failure and reconnects on retry', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('store unavailable'));
    const handle = await mountRecovery();
    await act(async () => {
      expect(await handle.current?.restorePurchases()).toBe('failed');
    });
    expect(handle.current?.isRestoringPurchases).toBe(false);
    expect(handle.current?.errorMessage).toBe('Failed to restore purchases. Try again.');
    await act(async () => {
      expect(await handle.current?.restorePurchases()).toBe('restored');
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it('fences signout while the store connection answers', async () => {
    const gate = Promise.withResolvers<boolean>();
    mocks.connect.mockReturnValue(gate.promise);
    const handle = await mountRecovery();
    await act(async () => {
      const pending = handle.current?.restorePurchases();
      bumpAuthEpoch();
      gate.resolve(true);
      expect(await pending).toBe(null);
    });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.backend).not.toHaveBeenCalled();
  });

  it('fences signout while the subscription lookup answers', async () => {
    const gate = Promise.withResolvers<Purchase[]>();
    mocks.available.mockReturnValue(gate.promise);
    const handle = await mountRecovery();
    await act(async () => {
      const pending = handle.current?.restorePurchases();
      await vi.waitFor(() => {
        expect(mocks.available).toHaveBeenCalled();
      });
      bumpAuthEpoch();
      gate.resolve([legacyPurchase]);
      expect(await pending).toBe(null);
    });
    expect(mocks.backend).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive restore lookup without finishing the transaction', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.available.mockReturnValue(Promise.withResolvers<Purchase[]>().promise);
    const handle = await mountRecovery();
    await act(async () => {
      const pending = handle.current?.restorePurchases();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await pending).toBe('failed');
    });
    expect(mocks.backend).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(handle.current?.isRestoringPurchases).toBe(false);
  });
});
