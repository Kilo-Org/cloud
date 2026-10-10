import { createElement, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { type StoreCreditProductListing } from './store-products';
import { useStoreCreditProducts } from './use-store-credit-products';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({ Platform: mockedPlatform }));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

const mockedBackend = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    credits: {
      getMobileStoreProducts: {
        queryOptions: () => ({
          queryKey: ['mobile-credit-products'],
          queryFn: mockedBackend.query,
        }),
      },
    },
  }),
}));

const BACKEND_CATALOG = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [
    {
      amountUsd: 10,
      appleProductId: 'credits.usd10.v1',
      googleProductId: 'credits_usd10',
    },
  ],
};

const fetchStoreProducts = vi.fn();
const reconnectStore = vi.fn().mockResolvedValue(true);

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
  probe.current = useStoreCreditProducts({ connected, fetchStoreProducts, reconnectStore });
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

beforeEach(() => {
  mockedPlatform.OS = 'ios';
  mockedBackend.query.mockReset();
  mockedBackend.query.mockResolvedValue(BACKEND_CATALOG);
  fetchStoreProducts.mockReset();
  reconnectStore.mockReset();
  reconnectStore.mockResolvedValue(true);
});

/**
 * A manual retry re-arms the bounded store-connection wait. When the retry
 * answers while the connection flag is still false, the pending timer must not
 * survive it: 8s later it re-raised the store-unavailable banner over packs the
 * store had just priced and the screen had left enabled.
 */
describe('useStoreCreditProducts store-connection timeout', () => {
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

describe('useStoreCreditProducts retry reconnect', () => {
  it('reconnects the IAP owner before refetching the store products', async () => {
    const calls: string[] = [];
    reconnectStore.mockImplementation(() => {
      calls.push('reconnect');
      return true;
    });
    fetchStoreProducts.mockImplementation(() => {
      calls.push('fetch');
      return [pricedListing];
    });

    const { api, unmount } = await mountHook();
    try {
      await act(async () => {
        await api().refetch();
      });

      // expo-iap drops its purchase-update listeners when initialization fails,
      // so the retry must restore them before it can enable a priced row.
      expect(calls).toEqual(['reconnect', 'fetch']);
    } finally {
      unmount();
    }
  });

  it('still refetches when the reconnect itself fails', async () => {
    reconnectStore.mockRejectedValue(new Error('NotPrepared'));
    fetchStoreProducts.mockResolvedValue([pricedListing]);

    const { api, unmount } = await mountHook();
    try {
      await act(async () => {
        await api().refetch();
      });

      expect(fetchStoreProducts).toHaveBeenCalledTimes(1);
      expect(api().products.some(product => product.storeProductId !== null)).toBe(true);
    } finally {
      unmount();
    }
  });
});

describe('useStoreCreditProducts paused store query', () => {
  it('keeps the known packs while the store query is paused offline', async () => {
    const { api, queryClient, setConnected, unmount } = await mountHook();
    try {
      // The backend catalog is cached while the store is still disconnected.
      await waitFor(() => queryClient.getQueryData(['mobile-credit-products']) !== undefined);

      // Going offline pauses the store query: it is `pending` without fetching,
      // so TanStack reports `isLoading: false` and there is no error. Before the
      // fix that read as an empty catalog and hid the pack the backend named.
      onlineManager.setOnline(false);
      setConnected(true);
      await waitFor(() => !api().isLoading);

      expect(api().catalogEmpty).toBe(false);
      expect(api().isError).toBe(false);
      expect(api().storeUnavailable).toBe(false);
      expect(api().products).toHaveLength(1);
      expect(api().products[0]?.backend.amountUsd).toBe(10);
      expect(api().products[0]?.storeProductId).toBeNull();
    } finally {
      onlineManager.setOnline(true);
      unmount();
    }
  });

  it('reports an empty catalog only when the backend answers with no packs', async () => {
    mockedBackend.query.mockResolvedValue({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [],
    });
    const { api, queryClient, setConnected, unmount } = await mountHook();
    try {
      await waitFor(() => queryClient.getQueryData(['mobile-credit-products']) !== undefined);

      onlineManager.setOnline(false);
      setConnected(true);
      await waitFor(() => api().catalogEmpty);

      expect(api().isLoading).toBe(false);
      expect(api().products).toHaveLength(0);
      expect(api().storeUnavailable).toBe(false);
    } finally {
      onlineManager.setOnline(true);
      unmount();
    }
  });
});
