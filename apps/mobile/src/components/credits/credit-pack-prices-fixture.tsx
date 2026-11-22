/* eslint-disable max-lines -- One fixture file holds the fixed catalogs, the states and the purchase wiring; a second file would split one screen's answers. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createPurchaseError, ErrorCode } from 'expo-iap';
import { useCallback, useMemo, useState } from 'react';

import {
  joinStoreCreditProducts,
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from '@/lib/credits/store-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import {
  createStoreCreditPurchaseActions,
  type CreditPurchaseFailure,
  creditStoreTimeoutKey,
  getStoreCreditPurchaseErrorMessageKey,
} from '@/lib/credits/use-store-credit-purchase';
import { creditStoreProductsKey } from '@/lib/credits/use-store-credit-products';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { TRPCProvider, useTRPC } from '@/lib/trpc';
import { CreditPurchaseScreen } from './credit-purchase-screen';
import {
  CreditNativeIapContext,
  type CreditNativeIapContextValue,
} from './credit-native-iap-owner';

// Development-only fixture for the design gate and for a manual look at pack
// rows the emulator cannot produce: it has no store connection, so every real
// row is unpriced there. The fixture mounts the real screen against fixed store
// answers and never reaches the network. `state=priced` prices every pack,
// `state=partly-priced` leaves the largest pack unpriced, which is the only
// state that renders a row-level price status beside a priced row,
// `state=priced-expiring` prices every pack from the backend's expiring Play
// catalog at the same fixed prices, so every pack grants credits that expire one
// calendar year after purchase while the empty credit-block answer stays, and
// `state=completing` prices every pack and starts a purchase on the first one,
// which an emulator cannot reach without a store. The remaining states seed the
// money-safety surfaces with inert exits: `unresolved` restores an earlier
// charge on a current SKU, `legacy-unresolved` restores a retired Play SKU whose
// replacement is the consent target, `refused-unresolved` restores a charge the
// backend will never credit, `waiting` and `pending` show the store-wait and
// pending-payment copy on the pack's row and in the card, `failed` shows the
// inline error for a store that lost its billing connection, which a pack row
// tap starts again through the real purchase path, and `timed-out` shows the
// store deadline's inline error.

export type CreditPackPricesFixtureState =
  | 'priced'
  | 'partly-priced'
  | 'priced-expiring'
  | 'completing'
  | 'unresolved'
  | 'legacy-unresolved'
  | 'refused-unresolved'
  | 'waiting'
  | 'pending'
  | 'failed'
  | 'timed-out';

const FIXTURE_STATES = [
  'priced',
  'partly-priced',
  'priced-expiring',
  'completing',
  'unresolved',
  'legacy-unresolved',
  'refused-unresolved',
  'waiting',
  'pending',
  'failed',
  'timed-out',
] as const satisfies readonly CreditPackPricesFixtureState[];

export function isCreditPackPricesFixtureState(
  value: string | undefined
): value is CreditPackPricesFixtureState {
  return value !== undefined && FIXTURE_STATES.some(state => state === value);
}

/** Which store wait each state paints, if any. */
const WAIT_KIND_BY_STATE = {
  priced: null,
  'partly-priced': null,
  'priced-expiring': null,
  completing: null,
  unresolved: null,
  'legacy-unresolved': null,
  'refused-unresolved': null,
  waiting: 'store',
  pending: 'pending',
  failed: null,
  'timed-out': null,
} as const satisfies Record<CreditPackPricesFixtureState, 'store' | 'pending' | null>;

/** Store prices in the shape the German Play store returns for these packs. */
const PLAY_PRICES = ['10,99 €', '54,99 €', '109,99 €', '549,99 €'] as const;

/**
 * The refusal a store answers with when it has no live billing connection. It is
 * the fault the `failed` state shows: nothing reached the store, so the same tap
 * can repeat it after a reconnect. The store's own factory builds it, so it
 * carries the shape the real purchase path maps; its message is the store's
 * diagnostic and never reaches the screen.
 */
const STORE_CONNECTION_REFUSAL = createPurchaseError({
  code: ErrorCode.NotPrepared,
  message: 'Billing client not ready',
});

/**
 * How long the stand-in store takes to refuse a purchase. A real store answers
 * from another process, so the screen's clear-then-publish cycle lasts long
 * enough to see: the tile goes while the request is open and returns after it.
 */
const STORE_ANSWER_DELAY_MS = 600;

/** Waits out the store's own answer time, so the refusal is not instantaneous. */
async function waitForStoreAnswer(): Promise<void> {
  const answer = Promise.withResolvers<undefined>();
  setTimeout(answer.resolve, STORE_ANSWER_DELAY_MS);
  await answer.promise;
}

/**
 * The inline error tile a state starts with, before any tap publishes its own.
 * `failed` reads the real mapper's key for a store that lost its billing
 * connection, so its tile is the sentence production shows; `timed-out` reads
 * the deadline key of the storefront this device buys from.
 */
function initialErrorMessageKey(state: CreditPackPricesFixtureState): string | null {
  if (state === 'failed') {
    return getStoreCreditPurchaseErrorMessageKey(STORE_CONNECTION_REFUSAL, getCreditStorefront());
  }
  if (state === 'timed-out') {
    return creditStoreTimeoutKey(getCreditStorefront());
  }
  return null;
}

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

/**
 * The same four packs from the backend's expiring Play catalog: each
 * `googleProductId` carries the `_1year_v2` suffix of the verified SKU shape,
 * and every pack grants credits that expire one calendar year after purchase.
 */
const EXPIRING_BACKENDS: typeof backends = {
  appAccountToken: backends.appAccountToken,
  products: backends.products.map(product => ({
    amountUsd: product.amountUsd,
    appleProductId: product.appleProductId,
    googleProductId: `${product.googleProductId}_1year_v2`,
    creditExpiryPolicy: 'one_year' as const,
  })),
};

const creditBlocks: RouterOutputs['user']['getCreditBlocks'] = {
  creditBlocks: [],
  deductions: [],
  totalBalance_mUsd: 0,
  isFirstPurchase: true,
  autoTopUpEnabled: false,
};

const grantHistory: RouterOutputs['user']['getCreditGrantHistory'] = {
  grants: [],
  hasMore: false,
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

/** The catalog a state answers with. */
function backendProductsFor(state: CreditPackPricesFixtureState): typeof backends {
  return state === 'priced-expiring' ? EXPIRING_BACKENDS : backends;
}

function listings(state: CreditPackPricesFixtureState): StoreCreditProductListing[] {
  const catalog = backendProductsFor(state);
  const priced = state === 'partly-priced' ? catalog.products.slice(0, 3) : catalog.products;
  // The join key differs per store, so each listing carries the id of the
  // storefront the app reports. A Play id would join to nothing on the other
  // store, and the state would silently render as store-unavailable.
  const idKey = getCreditStorefront() === 'play' ? 'googleProductId' : 'appleProductId';
  return priced.map(product => ({
    id: product[idKey],
    displayPrice: PLAY_PRICES[catalog.products.indexOf(product)] ?? '',
  }));
}

/**
 * Read-only tRPC client for the fixture. Every read is answered from the
 * constants above; no request leaves the device, and a write is refused before
 * any mutation function runs.
 */
function createFixtureClient(state: CreditPackPricesFixtureState) {
  const catalog = backendProductsFor(state);
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
          if (url.includes('/user.getCreditGrantHistory')) {
            return fixtureResponse(grantHistory);
          }
          if (url.includes('/credits.getMobileStoreProducts')) {
            return fixtureResponse(catalog);
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
    const catalog = backendProductsFor(state);
    const me = trpc.user.getMe.queryOptions();
    queryClient.setQueryData(me.queryKey, meResponse);
    const balance = trpc.user.getContextBalance.queryOptions({});
    queryClient.setQueryData(balance.queryKey, balanceResponse);
    const blocks = trpc.user.getCreditBlocks.queryOptions({});
    queryClient.setQueryData(blocks.queryKey, creditBlocks);
    queryClient.setQueryData(
      creditStoreProductsKey(meResponse.id),
      joinStoreCreditProducts({
        appAccountToken: catalog.appAccountToken,
        backendProducts: catalog.products,
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
  const trpcClient = useMemo(() => createFixtureClient(state), [state]);
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SeededScreen state={state} />
      </TRPCProvider>
    </QueryClientProvider>
  );
}

export function CreditPackPricesFixture({ state }: { state: CreditPackPricesFixtureState }) {
  const waitKind = WAIT_KIND_BY_STATE[state];
  // The purchase phase, keyed by store product id, as the owner reports it: the
  // failed state publishes its refusal here, and no other state publishes one.
  const {
    begin: beginPurchase,
    clearWhere: clearPurchaseFailure,
    snapshot: { states, pendingKeys },
  } = useKeyedSurfaceFeedback<string, CreditPurchaseFailure>();
  // Only the failed state runs the real start path, so only there can a row
  // report its own open request.
  const tapDriven = state === 'failed';
  const pendingProductId = tapDriven ? (pendingKeys[0] ?? null) : null;
  // The screen renders one error line, so the first failed entry names it. A
  // state that never taps keeps its own tile, and a tap replaces it with the key
  // the mapper published. Only the tap state reads the entry, so an entry
  // another state left behind cannot repaint this one.
  const failedFailure = tapDriven
    ? [...states.values()].find(phase => phase.status === 'failed')
    : undefined;
  // The tile has two owners and only one at a time. The state's own key stands
  // until the person taps a pack. The first tap hands the tile to the attempt,
  // so the screen's clear-then-publish cycle runs: no tile while the request is
  // open, the mapper's key after it refuses. Deriving that from the feedback
  // alone cannot work, because clearing removes the entry and the seed would
  // come back in its place.
  //
  // The hand-off names the state that made it. This component stays mounted
  // across a link for another state, so a bare flag would leave the next state
  // without the tile it exists to show. A tap in a state that never publishes a
  // failure also keeps its own tile: only the failed state runs the purchase.
  const [tappedState, setTappedState] = useState<CreditPackPricesFixtureState | null>(null);
  const tapped = tapDriven && tappedState === state;
  const errorMessageKey = tapped
    ? (failedFailure?.failure.messageKey ?? null)
    : initialErrorMessageKey(state);
  const clearError = useCallback(() => {
    if (tapDriven) {
      setTappedState(state);
    }
    for (const [key, phase] of states) {
      if (phase.status === 'failed') {
        clearPurchaseFailure(key, () => true);
      }
    }
  }, [clearPurchaseFailure, state, states, tapDriven]);

  const storefront = getCreditStorefront();
  const catalog = backendProductsFor(state);
  // The real actions for the tap path: the store refuses the request the way a
  // device without a billing client does, and every follow-up is inert because
  // nothing was charged.
  const actions = useMemo(
    () =>
      createStoreCreditPurchaseActions({
        storefront,
        appAccountToken: catalog.appAccountToken,
        creditPackAppleProductIds: catalog.products.map(product => product.appleProductId),
        creditPackGoogleProductIds: catalog.products.map(product => product.googleProductId),
        // The store answers the way a device without a billing client does, and
        // it takes a moment to do so. A store call answers from another process,
        // so an instant refusal would hide the screen's own clear-then-publish
        // cycle behind one frame.
        requestPurchase: async () => {
          await waitForStoreAnswer();
          throw STORE_CONNECTION_REFUSAL;
        },
        completeAppStorePurchase: async () => {
          await Promise.resolve();
        },
        completePlayPurchase: async () => {
          await Promise.resolve();
        },
        finishTransaction: async () => {
          await Promise.resolve();
        },
        invalidateAfterCompletion: async () => {
          await Promise.resolve();
        },
        isAccountCurrent: () => true,
        // The screen paints the inline tile here; a toast would repeat it.
        showError: () => undefined,
      }),
    [catalog, storefront]
  );

  const purchase = useCallback(
    async (pack: StoreCreditProduct): Promise<boolean> => {
      const storeProductId = pack.storeProductId;
      if (!tapDriven || storeProductId === null) {
        // Every other state keeps the inert tap: nothing is chargeable, and the
        // state under test is the layout or a hand-seeded tile.
        await Promise.resolve();
        return false;
      }
      const attempt = beginPurchase(storeProductId);
      if (attempt === null) {
        return false;
      }
      const outcome = await actions.purchase(pack);
      if (!attempt.owns()) {
        return false;
      }
      const failure = outcome.started ? null : outcome.failure;
      if (failure === null) {
        attempt.abandon();
        return outcome.started;
      }
      attempt.fail(failure);
      return false;
    },
    [actions, beginPurchase, tapDriven]
  );

  const store = useMemo<CreditNativeIapContextValue>(() => {
    const fixtureListings = listings(state);
    // An earlier charge the emulator cannot produce. `legacy-unresolved` keeps a
    // retired Play SKU as the earlier request and names a current replacement as
    // the consent target, which no row could ever name by itself.
    const hasUnresolvedPurchase =
      state === 'unresolved' || state === 'legacy-unresolved' || state === 'refused-unresolved';
    let purchaseResolution: CreditNativeIapContextValue['purchaseResolution'] = 'unknown';
    if (state === 'legacy-unresolved') {
      purchaseResolution = 'not-found';
    } else if (state === 'refused-unresolved') {
      purchaseResolution = 'terminal-refusal';
    }
    return {
      connected: true,
      fetchStoreProducts: async () => {
        await Promise.resolve();
        return fixtureListings;
      },
      reconnectStore: async () => {
        await Promise.resolve();
        return true;
      },
      purchase,
      // The money exits are inert in every state, including the ones that
      // restore an earlier charge: a reconciliation here reports nothing held
      // and a Buy again tap charges nothing.
      reconcilePurchase: async () => {
        await Promise.resolve();
        return false;
      },
      buyAgain: async () => {
        await Promise.resolve();
        return false;
      },
      buyAgainProductId:
        state === 'legacy-unresolved' || state === 'refused-unresolved'
          ? (fixtureListings[2]?.id ?? null)
          : null,
      hasUnresolvedPurchase,
      purchaseResolution,
      // The completing state keeps the first pack's purchase open, which is the
      // only way to render its in-flight label without a store. The failed state
      // reads the entry its own request holds.
      completingProductId:
        state === 'completing' ? (fixtureListings[0]?.id ?? null) : pendingProductId,
      purchaseWait:
        waitKind === null ? null : { productId: fixtureListings[0]?.id ?? '', kind: waitKind },
      errorMessageKey,
      completedPurchaseCount: 0,
      clearError,
    };
  }, [clearError, errorMessageKey, pendingProductId, purchase, state, waitKind]);

  return (
    <CreditNativeIapContext.Provider value={store}>
      <FixtureSession key={state} state={state} />
    </CreditNativeIapContext.Provider>
  );
}
