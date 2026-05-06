import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppleCreditProducts } from './use-apple-credit-products';
import { useAppleCreditPurchase } from './use-apple-credit-purchase';
import { finishStoreKitTransaction, purchaseStoreKitProduct } from './storekit';

const testState = vi.hoisted(() => ({
  backendProducts: [
    {
      id: 'com.kilocode.kiloapp.credits.small.999',
      tier: 'small' as const,
      creditedCents: 699,
      creditedMicrodollars: 6_990_000,
    },
  ],
  invalidations: [] as unknown[],
  mutationResult: {
    creditedCents: 699,
    creditedMicrodollars: 6_990_000,
    alreadyProcessed: false,
  },
  mutationShouldReject: false,
  platform: 'ios',
  storeKitProducts: [
    {
      id: 'com.kilocode.kiloapp.credits.small.999',
      title: 'Small Credit Pack',
      localizedPrice: '$9.99',
    },
  ],
}));

const mocks = vi.hoisted(() => ({
  finishStoreKitTransaction: vi.fn(),
  fetchStoreKitProducts: vi.fn(),
  purchaseStoreKitProduct: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return testState.platform;
    },
  },
}));

vi.mock('./storekit', () => mocks);

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    error: null,
    isPending: false,
    mutateAsync: async () => {
      if (testState.mutationShouldReject) {
        throw new Error('Backend rejected purchase');
      }
      return testState.mutationResult;
    },
  }),
  useQuery: (options: { queryKey?: unknown[] }) => {
    const isStoreKitQuery = options.queryKey?.[0] === 'apple-credit-storekit-products';
    return {
      data: isStoreKitQuery ? testState.storeKitProducts : { products: testState.backendProducts },
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({
    invalidateQueries: async (filter: unknown) => {
      testState.invalidations.push(filter);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      completeAppleCreditPurchase: {
        mutationOptions: () => ({}),
      },
      getAppleCreditProducts: {
        queryOptions: () => ({ queryKey: ['user', 'getAppleCreditProducts'] }),
      },
      getContextBalance: {
        pathFilter: () => ({ queryKey: ['user', 'getContextBalance'] }),
      },
      getCreditBlocks: {
        pathFilter: () => ({ queryKey: ['user', 'getCreditBlocks'] }),
      },
    },
  }),
}));

beforeEach(() => {
  testState.invalidations = [];
  testState.mutationShouldReject = false;
  testState.mutationResult = {
    creditedCents: 699,
    creditedMicrodollars: 6_990_000,
    alreadyProcessed: false,
  };
  testState.platform = 'ios';
  vi.clearAllMocks();
  mocks.fetchStoreKitProducts.mockResolvedValue(testState.storeKitProducts);
  mocks.purchaseStoreKitProduct.mockResolvedValue({
    productId: 'com.kilocode.kiloapp.credits.small.999',
    transactionJws: 'signed-transaction',
    nativeTransaction: { id: 'native-transaction' },
  });
  mocks.finishStoreKitTransaction.mockResolvedValue(undefined);
});

describe('useAppleCreditProducts', () => {
  it('returns no products outside iOS', () => {
    testState.platform = 'android';

    expect(useAppleCreditProducts().products).toEqual([]);
  });
});

describe('useAppleCreditPurchase', () => {
  it('finishes the StoreKit transaction after backend success', async () => {
    const result = await useAppleCreditPurchase().purchaseProduct(
      'com.kilocode.kiloapp.credits.small.999'
    );

    expect(result.alreadyProcessed).toBe(false);
    expect(purchaseStoreKitProduct).toHaveBeenCalledWith('com.kilocode.kiloapp.credits.small.999');
    expect(testState.invalidations).toEqual([
      { queryKey: ['user', 'getContextBalance'] },
      { queryKey: ['user', 'getCreditBlocks'] },
    ]);
    expect(finishStoreKitTransaction).toHaveBeenCalledWith({ id: 'native-transaction' });
  });

  it('finishes the StoreKit transaction after already-processed backend success', async () => {
    testState.mutationResult = {
      creditedCents: 699,
      creditedMicrodollars: 6_990_000,
      alreadyProcessed: true,
    };

    const result = await useAppleCreditPurchase().purchaseProduct(
      'com.kilocode.kiloapp.credits.small.999'
    );

    expect(result.alreadyProcessed).toBe(true);
    expect(finishStoreKitTransaction).toHaveBeenCalledWith({ id: 'native-transaction' });
  });

  it('does not finish the StoreKit transaction when backend completion fails', async () => {
    testState.mutationShouldReject = true;

    await expect(
      useAppleCreditPurchase().purchaseProduct('com.kilocode.kiloapp.credits.small.999')
    ).rejects.toThrow('Backend rejected purchase');

    expect(finishStoreKitTransaction).not.toHaveBeenCalled();
  });
});
