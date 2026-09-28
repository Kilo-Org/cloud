import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';

import { type AppStoreKiloPassProduct } from './store-products';
import { useStoreKiloPassProducts } from './use-store-kilo-pass-products';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({ Platform: mockedPlatform }));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('@/lib/trpc', () => {
  const backendCatalog = vi.fn().mockResolvedValue({
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: [],
  });
  return {
    useTRPC: () => ({
      kiloPass: {
        getMobileStoreProducts: {
          pathFilter: () => ({ queryKey: ['mobile-products'] }),
          queryOptions: () => ({
            queryKey: ['mobile-products'],
            queryFn: backendCatalog,
          }),
        },
      },
    }),
  };
});

const fetchStoreProducts = vi.fn().mockResolvedValue([]);

const cachedProduct: AppStoreKiloPassProduct = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  appleProductId: 'com.kilo.pass.tier19.monthly',
  cadence: 'monthly',
  description: 'Kilo Pass',
  displayPrice: '$24.99',
  googleBasePlanId: 'monthly-v1',
  googleProductId: 'kilopass_tier19',
  storeProduct: {
    id: 'com.kilo.pass.tier19.monthly',
    displayPrice: '$24.99',
    title: 'Kilo Pass',
    description: 'Kilo Pass',
  },
  suggestedStoreMonthlyPriceUsd: 24.7,
  tier: 'tier_19',
  title: 'Kilo Pass',
  webMonthlyPriceUsd: 19,
};

const cachedProductsKey = ['kilo-pass', 'app-store-products', 'user-1'];

type HookResult = ReturnType<typeof useStoreKiloPassProducts>;

type Probe = {
  current: HookResult | null;
  setConnected: (connected: boolean) => void;
};

function Harness({ probe }: { probe: Probe }) {
  const [connected, setConnected] = useState(false);
  probe.setConnected = setConnected;
  probe.current = useStoreKiloPassProducts({ connected, fetchStoreProducts });
  return null;
}

async function mountHook() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(cachedProductsKey, [cachedProduct]);
  const probe: Probe = { current: null, setConnected: () => undefined };
  const rendered = await renderWithProviders(createElement(Harness, { probe }), { queryClient });
  return {
    ...rendered,
    api: () => {
      if (probe.current === null) {
        throw new Error('hook has not rendered yet');
      }
      return probe.current;
    },
    setConnected: (connected: boolean) => {
      probe.setConnected(connected);
    },
  };
}

/**
 * The bounded store-connection wait must not outlive the connection it was
 * bounding: a re-entry paints the cached tier tiles while the store reconnects,
 * and a store that answers after the 8s bound must not leave the false
 * "Could not connect" retry card over those tiles.
 */
describe('useStoreKiloPassProducts store-connection timeout', () => {
  beforeEach(() => {
    mockedPlatform.OS = 'ios';
    fetchStoreProducts.mockClear();
  });

  it('clears the connection-timeout error once the store actually connects', async () => {
    vi.useFakeTimers();
    const { api, setConnected, unmount } = await mountHook();
    try {
      // The cached catalog paints while the store is still reconnecting.
      expect(api().products).toHaveLength(1);
      expect(api().isLoading).toBe(false);
      expect(api().isError).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(api().isError).toBe(true);
      expect(api().errorMessage).not.toBeNull();

      // The store answers after the bound: the tiles come back from cache and
      // the timeout message is gone.
      await act(async () => {
        setConnected(true);
        await Promise.resolve();
      });
      expect(api().isError).toBe(false);
      expect(api().errorMessage).toBeNull();
      expect(api().products).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it('keeps the bounded timeout error while the store never connects', async () => {
    vi.useFakeTimers();
    const { api, unmount } = await mountHook();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });

      // Nothing connects, so the bounded wait still surfaces the retry card.
      expect(api().isError).toBe(true);
      expect(api().errorMessage).not.toBeNull();
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });
});
