import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';

import { type StoreCreditProductListing } from './store-products';
import { useStoreCreditProducts } from './use-store-credit-products';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({ Platform: mockedPlatform }));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('@/lib/trpc', () => {
  const backendCatalog = vi.fn().mockResolvedValue({
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: [
      {
        amountUsd: 10,
        appleProductId: 'credits.usd10.v1',
        googleProductId: 'credits_usd10',
      },
    ],
  });
  return {
    useTRPC: () => ({
      credits: {
        getMobileStoreProducts: {
          queryOptions: () => ({
            queryKey: ['mobile-credit-products'],
            queryFn: backendCatalog,
          }),
        },
      },
    }),
  };
});

const fetchStoreProducts = vi.fn();

const pricedListing: StoreCreditProductListing = {
  id: 'credits.usd10.v1',
  displayPrice: '$10.99',
};

type HookResult = ReturnType<typeof useStoreCreditProducts>;

type Probe = {
  current: HookResult | null;
  setConnected: (connected: boolean) => void;
};

function Harness({ probe }: { probe: Probe }) {
  const [connected, setConnected] = useState(false);
  probe.setConnected = setConnected;
  probe.current = useStoreCreditProducts({ connected, fetchStoreProducts });
  return null;
}

async function mountHook() {
  const queryClient = createTestQueryClient();
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
 * A manual retry re-arms the bounded store-connection wait. When the retry
 * answers while the connection flag is still false, the pending timer must not
 * survive it: 8s later it re-raised the store-unavailable banner over packs the
 * store had just priced and the screen had left enabled.
 */
describe('useStoreCreditProducts store-connection timeout', () => {
  beforeEach(() => {
    mockedPlatform.OS = 'ios';
    fetchStoreProducts.mockReset();
  });

  it('does not re-raise the store-unavailable banner after a successful retry', async () => {
    vi.useFakeTimers();
    fetchStoreProducts.mockRejectedValue(new Error('store offline'));
    const { api, unmount } = await mountHook();
    try {
      // The store never connects, so the bounded wait raises the banner.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(api().storeUnavailable).toBe(true);

      // The retry answers while `connected` is still false: the packs are
      // priced, so the banner is cleared and the rows are purchasable again.
      fetchStoreProducts.mockResolvedValue([pricedListing]);
      await act(async () => {
        await api().refetch();
      });
      expect(api().storeUnavailable).toBe(false);
      expect(api().products.some(product => product.storeProductId !== null)).toBe(true);

      // The re-armed bound must not fire over the now-priced packs.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(api().storeUnavailable).toBe(false);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it('still raises the banner when the retry keeps failing', async () => {
    vi.useFakeTimers();
    fetchStoreProducts.mockRejectedValue(new Error('store offline'));
    const { api, unmount } = await mountHook();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(api().storeUnavailable).toBe(true);

      // The retry fails again: the bounded wait must still surface the banner
      // for the retry that follows.
      await act(async () => {
        await api().refetch();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(api().storeUnavailable).toBe(true);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });
});
