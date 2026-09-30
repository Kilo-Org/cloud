import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  finishTransaction as finishStoreTransaction,
  initConnection,
  requestPurchase as requestStorePurchase,
  restorePurchases as restoreStorePurchases,
} from 'expo-iap';

import { useAuth } from '@/lib/auth/auth-context';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { createStoreCreditPurchaseActions } from '@/lib/credits/use-store-credit-purchase';
import { fetchPendingStorePurchases } from '@/lib/iap/pending-store-purchases';
import { createAppStoreKiloPassPurchaseActions } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { useTRPC } from '@/lib/trpc';

/**
 * Recovery never reports on screen: a purchase that cannot be completed now is
 * retried on the next pass, and the balance queries are the signal that it did.
 * Logged, so a failure that never clears is diagnosable instead of invisible.
 */
function logRecoveryError(message: string | null): void {
  if (message) {
    // eslint-disable-next-line no-console -- a purchase that never credits must be diagnosable
    console.warn(`[iap-recovery] ${message}`);
  }
}

/**
 * A store call must answer inside this window or the pass gives up.
 *
 * StoreKit and Play Billing both answer slowly on a cold connection, and a call
 * that never answers is worse than one that fails: the pass holds its in-flight
 * guard, so recovery is dead for the rest of the process and silent about it.
 * Measured on a simulator on 2026-09-29: the pass entered with 14 known product
 * ids, then `initConnection` never settled — no result, no failure, no further
 * recovery for the life of that app process.
 */
const STORE_CALL_DEADLINE_MS = 15_000;

async function withStoreDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  const { promise: deadline, reject: failDeadline } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    failDeadline(new Error(`${label} did not answer within ${STORE_CALL_DEADLINE_MS} ms`));
  }, STORE_CALL_DEADLINE_MS);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Purchase screens close the global connection on unmount; each pass reconnects. */
async function connectStore(): Promise<void> {
  await withStoreDeadline(initConnection(), 'the store connection');
}

/**
 * Completes store purchases the backend has not granted yet, for both in-app
 * purchase flows, without the user opening a purchase screen.
 *
 * A purchase becomes incomplete when the app dies between the store charging
 * the user and the backend granting the credits: StoreKit keeps the transaction
 * unfinished precisely so a later connection can finish it, and the grant is
 * keyed on the store transaction id, so completing it twice grants once.
 *
 * The purchase screens cannot own this pass. Each of them mounts the app's
 * single `useIAP` call site, so their recovery runs only while that screen is
 * open: a user who is charged and then relaunches the app reached Profile, saw
 * an unchanged balance, and stayed short one pack until they opened the purchase
 * screen again — measured at 63 minutes on 2026-09-29.
 *
 * This pass therefore does not mount `useIAP`: two `useIAP` mounts double-handle
 * every purchase, so it reads the store's value-returning queries and completes
 * what it finds there. Each flow's own completion path does the grant, and their
 * module-level completion registry makes a purchase that this pass and a
 * purchase screen deliver at the same moment complete once.
 *
 * Cost: one store lookup when the app starts and one when it returns to the
 * foreground, plus a backend call only for a purchase that is actually pending.
 */
export function StorePurchaseRecoveryMount(): null {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { token, isLoading, isSigningOut } = useAuth();
  const signedIn = Boolean(token) && !isLoading && !isSigningOut;
  // The store this device has. Read from the one helper that owns that fork, so
  // this pass completes against the same store the purchase screens sell from.
  const storefront = getCreditStorefront();
  // The auth epoch this mount belongs to. The `(app)` layout unmounts it on
  // sign-out, but a pass already in flight keeps running; the epoch fences it so
  // the next account's session never posts the old account's receipts.
  const authEpochRef = useRef(currentAuthEpoch());

  const creditsCatalog = useQuery({
    ...trpc.credits.getMobileStoreProducts.queryOptions(),
    enabled: signedIn,
  });
  const kiloPassCatalog = useQuery({
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    enabled: signedIn,
  });

  const completeAppStoreCredit = useMutation(
    trpc.credits.completeAppStorePurchase.mutationOptions()
  );
  const completePlayCredit = useMutation(trpc.credits.completePlayPurchase.mutationOptions());
  const completeAppStoreKiloPass = useMutation(
    trpc.kiloPass.completeAppStorePurchase.mutationOptions()
  );
  const completePlayKiloPass = useMutation(trpc.kiloPass.completePlayPurchase.mutationOptions());

  const creditPackAppleProductIds = useMemo(
    () => creditsCatalog.data?.products.map(product => product.appleProductId) ?? [],
    [creditsCatalog.data]
  );
  const creditPackGoogleProductIds = useMemo(
    () => creditsCatalog.data?.products.map(product => product.googleProductId) ?? [],
    [creditsCatalog.data]
  );
  const kiloPassAppleProductIds = useMemo(
    () => kiloPassCatalog.data?.products.map(product => product.appleProductId) ?? [],
    [kiloPassCatalog.data]
  );
  const kiloPassGoogleProductIds = useMemo(
    () => kiloPassCatalog.data?.products.map(product => product.googleProductId) ?? [],
    [kiloPassCatalog.data]
  );

  const invalidateAfterCreditCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const invalidateAfterKiloPassCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getPurchasePresentation.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const creditActions = useMemo(
    () =>
      createStoreCreditPurchaseActions({
        storefront,
        appAccountToken: creditsCatalog.data?.appAccountToken ?? '',
        creditPackAppleProductIds,
        creditPackGoogleProductIds,
        requestPurchase: requestStorePurchase,
        completeAppStorePurchase: completeAppStoreCredit.mutateAsync,
        completePlayPurchase: completePlayCredit.mutateAsync,
        finishTransaction: finishStoreTransaction,
        invalidateAfterCompletion: invalidateAfterCreditCompletion,
        isAccountCurrent: () => isCurrentAuthEpoch(authEpochRef.current),
        showError: logRecoveryError,
      }),
    [
      completeAppStoreCredit.mutateAsync,
      completePlayCredit.mutateAsync,
      creditPackAppleProductIds,
      creditPackGoogleProductIds,
      creditsCatalog.data?.appAccountToken,
      invalidateAfterCreditCompletion,
      storefront,
    ]
  );

  const kiloPassActions = useMemo(
    () =>
      createAppStoreKiloPassPurchaseActions({
        storefront,
        requestPurchase: requestStorePurchase,
        getAvailablePurchases: async () => {
          const pendingPurchases = await withStoreDeadline(
            fetchPendingStorePurchases(storefront),
            'the pending purchase lookup'
          );
          return pendingPurchases;
        },
        restorePurchases: restoreStorePurchases,
        completeAppStorePurchase: completeAppStoreKiloPass.mutateAsync,
        completePlayPurchase: completePlayKiloPass.mutateAsync,
        finishTransaction: finishStoreTransaction,
        enabledAppleProductIds: kiloPassAppleProductIds,
        enabledGoogleProductIds: kiloPassGoogleProductIds,
        invalidateAfterCompletion: invalidateAfterKiloPassCompletion,
        isAccountCurrent: () => isCurrentAuthEpoch(authEpochRef.current),
        showError: logRecoveryError,
      }),
    [
      completeAppStoreKiloPass.mutateAsync,
      completePlayKiloPass.mutateAsync,
      invalidateAfterKiloPassCompletion,
      kiloPassAppleProductIds,
      kiloPassGoogleProductIds,
      storefront,
    ]
  );

  const passInFlightRef = useRef(false);
  const rerunRequestedRef = useRef(false);
  const knownProductIdCount =
    creditPackAppleProductIds.length +
    creditPackGoogleProductIds.length +
    kiloPassAppleProductIds.length +
    kiloPassGoogleProductIds.length;

  const recoverUnfinishedPurchases = useCallback(async () => {
    // No catalog yet means no product id to match a purchase against, and no
    // reason to open a store connection.
    if (!signedIn || knownProductIdCount === 0) {
      return;
    }
    if (passInFlightRef.current) {
      rerunRequestedRef.current = true;
      return;
    }
    passInFlightRef.current = true;
    try {
      await connectStore();
      const pendingPurchases = await withStoreDeadline(
        fetchPendingStorePurchases(storefront),
        'the pending purchase lookup'
      );
      if (pendingPurchases.length === 0) {
        return;
      }
      // A pass belongs to the account that started it. Sign-out or a new sign-in
      // bumps the epoch (and unmounts this mount), but the pass is already
      // running, so it must not submit its completions under the new account.
      // The credit actions re-check this same predicate before every submission.
      if (!isCurrentAuthEpoch(authEpochRef.current)) {
        return;
      }
      // Each flow completes only the purchases it sells and ignores the rest, so
      // one list serves both. Neither reports on screen: a recovery that cannot
      // finish now is retried on the next pass, and the balance the queries
      // refresh is the signal that it did.
      await Promise.all([
        creditActions.recoverPurchases(pendingPurchases, { notifyErrors: false }),
        kiloPassActions.recoverPurchases(pendingPurchases, { notifyErrors: false }),
      ]);
    } catch (error) {
      // The store cannot answer, or the app is offline. Both are states the next
      // pass retries; the purchase stays unfinished in the store until then.
      // eslint-disable-next-line no-console -- a charged user with no credits must be diagnosable
      console.warn('[iap-recovery] unfinished purchase pass failed', String(error));
    } finally {
      passInFlightRef.current = false;
      if (rerunRequestedRef.current) {
        rerunRequestedRef.current = false;
        void recoverRef.current();
      }
    }
  }, [creditActions, kiloPassActions, knownProductIdCount, signedIn, storefront]);

  // Keep the next pass current before passive effects run. A pending store call
  // can settle immediately after a sign-out commit.
  const recoverRef = useRef(recoverUnfinishedPurchases);
  useLayoutEffect(() => {
    recoverRef.current = recoverUnfinishedPurchases;
  }, [recoverUnfinishedPurchases]);
  useLayoutEffect(
    () => () => {
      rerunRequestedRef.current = false;
    },
    []
  );

  const hasCreditProducts =
    creditPackAppleProductIds.length + creditPackGoogleProductIds.length > 0;
  const hasKiloPassProducts = kiloPassAppleProductIds.length + kiloPassGoogleProductIds.length > 0;

  // Each catalog arrives independently. If the second arrives during a pass,
  // the in-flight guard queues a pass with the newly available product IDs.
  useEffect(() => {
    if (signedIn && (hasCreditProducts || hasKiloPassProducts)) {
      void recoverRef.current();
    }
  }, [hasCreditProducts, hasKiloPassProducts, signedIn]);

  // Foreground regain: the background -> active edge only, so an active -> active
  // echo never re-runs the pass. The app keeps one `AppState` listener, in
  // `useAppLifecycle`, so this adds none.
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    const becameActive = !wasActiveRef.current && isActive;
    wasActiveRef.current = isActive;
    if (becameActive && signedIn) {
      void recoverRef.current();
    }
  }, [isActive, signedIn]);

  return null;
}
