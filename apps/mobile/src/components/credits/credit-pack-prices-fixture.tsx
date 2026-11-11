import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useMemo, useState } from 'react';

import {
  joinStoreCreditProducts,
  type StoreCreditProductListing,
} from '@/lib/credits/store-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { creditStoreProductsKey } from '@/lib/credits/use-store-credit-products';
import { TRPCProvider, useTRPC } from '@/lib/trpc';
import { CreditPurchaseScreen } from './credit-purchase-screen';
import {
  CreditNativeIapContext,
  type CreditNativeIapContextValue,
} from './credit-native-iap-owner';

// Development-only fixture for the design gate and for a manual look at pack
// rows the emulator cannot produce: it has no store connection, so every real
// row is unpriced there. The fixture mounts the real screen against fixed store
// answers and never reaches the network. `state=priced` prices every pack and
// `state=partly-priced` leaves the largest pack unpriced, which is the only
// state that renders a row-level price status beside a priced row.

export type CreditPackPricesFixtureState = 'priced' | 'partly-priced';

/** Store prices in the shape the German Play store returns for these packs. */
const PLAY_PRICES = ['10,99 €', '54,99 €', '109,99 €', '549,99 €'] as const;

type RouterOutputs = inferRouterOutputs<MobileRouter>;

const backends: RouterOutputs['credits']['getMobileStoreProducts'] = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: [
    {
      amountUsd: 10,
      appleProductId: 'credits.usd10.v1',
      googleProductId: 'credits_usd10',
      creditExpiryPolicy: 'never',
    },
    {
      amountUsd: 50,
      appleProductId: 'credits.usd50.v1',
      googleProductId: 'credits_usd50',
      creditExpiryPolicy: 'never',
    },
    {
      amountUsd: 100,
      appleProductId: 'credits.usd100.v1',
      googleProductId: 'credits_usd100',
      creditExpiryPolicy: 'never',
    },
    {
      amountUsd: 500,
      appleProductId: 'credits.usd500.v1',
      googleProductId: 'credits_usd500',
      creditExpiryPolicy: 'never',
    },
  ],
};

const creditBlocks: RouterOutputs['user']['getCreditBlocks'] = {
  creditBlocks: [],
  deductions: [],
  totalBalance_mUsd: 0,
  isFirstPurchase: true,
  autoTopUpEnabled: false,
};

const meResponse: RouterOutputs['user']['getMe'] = {
  success: true,
  id: 'credits-price-fixture',
  email: 'credits-price@example.com',
  isAdmin: false,
};

const balanceResponse: RouterOutputs['user']['getContextBalance'] = {
  balance: 0,
  isDepleted: true,
};

const FIXTURE_URL = 'http://credits-pack-prices-fixture.invalid/api/trpc';

function fixtureResponse(value: unknown): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data: value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function listings(state: CreditPackPricesFixtureState): StoreCreditProductListing[] {
  const priced = state === 'priced' ? backends.products : backends.products.slice(0, 3);
  // The join key differs per store, so each listing carries the id of the
  // storefront the app reports. A Play id would join to nothing on the other
  // store, and the state would silently render as store-unavailable.
  const idKey = getCreditStorefront() === 'play' ? 'googleProductId' : 'appleProductId';
  return priced.map(product => ({
    id: product[idKey],
    displayPrice: PLAY_PRICES[backends.products.indexOf(product)] ?? '',
  }));
}

/**
 * Read-only tRPC client for the fixture. Every read is answered from the
 * constants above; no request leaves the device, and a write is refused before
 * any mutation function runs.
 */
function createFixtureClient() {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: FIXTURE_URL,
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Credits price fixture does not allow writes');
          }
          if (url.includes('/user.getMe')) {
            return fixtureResponse({
              success: true,
              id: 'credits-price-fixture',
              email: 'credits-price@example.com',
              isAdmin: false,
            } satisfies RouterOutputs['user']['getMe']);
          }
          if (url.includes('/user.getContextBalance')) {
            return fixtureResponse({
              balance: 0,
              isDepleted: true,
            } satisfies RouterOutputs['user']['getContextBalance']);
          }
          if (url.includes('/user.getCreditBlocks')) {
            return fixtureResponse(creditBlocks);
          }
          if (url.includes('/credits.getMobileStoreProducts')) {
            return fixtureResponse(backends);
          }
          throw new Error(`Read not provided by credits price fixture: ${url}`);
        },
      }),
    ],
  });
}

/**
 * The cache is seeded during the first render of the subtree that reads it, and
 * that subtree owns the only client this cache has, so no mounted component
 * observes the write.
 */
function SeededScreen({ state }: { state: CreditPackPricesFixtureState }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  useState(() => {
    const me = trpc.user.getMe.queryOptions();
    queryClient.setQueryData(me.queryKey, meResponse);
    const balance = trpc.user.getContextBalance.queryOptions({});
    queryClient.setQueryData(balance.queryKey, balanceResponse);
    const blocks = trpc.user.getCreditBlocks.queryOptions({});
    queryClient.setQueryData(blocks.queryKey, creditBlocks);
    queryClient.setQueryData(
      creditStoreProductsKey(meResponse.id),
      joinStoreCreditProducts({
        appAccountToken: backends.appAccountToken,
        backendProducts: backends.products,
        storeProducts: listings(state),
        storefront: getCreditStorefront(),
      })
    );
  });
  return <CreditPurchaseScreen />;
}

/**
 * Mounted once per state: opening the other state's link repaints the route with
 * a new parameter, and React reuses the mounted tree. A fresh cache and client
 * per state keep the first state's answer out of the cache the second one reads.
 */
function FixtureSession({ state }: { state: CreditPackPricesFixtureState }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const trpcClient = useMemo(() => createFixtureClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SeededScreen state={state} />
      </TRPCProvider>
    </QueryClientProvider>
  );
}

export function CreditPackPricesFixture({ state }: { state: CreditPackPricesFixtureState }) {
  const store = useMemo<CreditNativeIapContextValue>(
    () => ({
      connected: true,
      fetchStoreProducts: async () => {
        await Promise.resolve();
        return listings(state);
      },
      reconnectStore: async () => {
        await Promise.resolve();
        return true;
      },
      // A press in the fixture never reaches a store: nothing is chargeable
      // here, and the state under test is the row layout, not a purchase.
      purchase: async () => {
        await Promise.resolve();
        return false;
      },
      completingProductId: null,
      errorMessageKey: null,
      completedPurchaseCount: 0,
      clearError: () => undefined,
    }),
    [state]
  );

  return (
    <CreditNativeIapContext.Provider value={store}>
      <FixtureSession key={state} state={state} />
    </CreditNativeIapContext.Provider>
  );
}
