import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  finishTransaction as finishStoreTransaction,
  initConnection,
  requestPurchase as requestStorePurchase,
} from 'expo-iap';

import { useAuth } from '@/lib/auth/auth-context';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { createStoreCreditPurchaseActions } from '@/lib/credits/use-store-credit-purchase';
import { fetchPendingStorePurchases } from '@/lib/iap/pending-store-purchases';
import { withStoreDeadline } from '@/lib/iap/store-call-deadline';
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

/** Purchase screens close the global connection on unmount; each pass reconnects. */
async function connectStore(): Promise<void> {
  await withStoreDeadline(initConnection(), 'the store connection');
}

/**
 * Completes credit-pack store purchases the backend has not granted yet,
 * without the user opening the purchase screen.
 *
 * A purchase becomes incomplete when the app dies between the store charging
 * the user and the backend granting the credits: StoreKit keeps the transaction
 * unfinished precisely so a later connection can finish it, and the grant is
 * keyed on the store transaction id, so completing it twice grants once.
 *
 * The purchase screen cannot own this pass. It mounts the app's single
 * `useIAP` call site, so its recovery runs only while that screen is
 * open: a user who is charged and then relaunches the app reached Profile, saw
 * an unchanged balance, and stayed short one pack until they opened the purchase
 * screen again — measured at 63 minutes on 2026-09-29.
 *
 * This pass therefore does not mount `useIAP`: two `useIAP` mounts double-handle
 * every purchase, so it reads the store's value-returning queries and completes
 * what it finds there. The credit completion path does the grant, and its
 * module-level completion registry makes a purchase that this pass and the
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

  const completeAppStoreCredit = useMutation(
    trpc.credits.completeAppStorePurchase.mutationOptions()
  );
  const completePlayCredit = useMutation(trpc.credits.completePlayPurchase.mutationOptions());

  const creditPackAppleProductIds = useMemo(
    () => creditsCatalog.data?.products.map(product => product.appleProductId) ?? [],
    [creditsCatalog.data]
  );
  const creditPackGoogleProductIds = useMemo(
    () => creditsCatalog.data?.products.map(product => product.googleProductId) ?? [],
    [creditsCatalog.data]
  );

  const invalidateAfterCreditCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
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

  const passInFlightRef = useRef(false);
  const rerunRequestedRef = useRef(false);
  const knownProductIdCount = creditPackAppleProductIds.length + creditPackGoogleProductIds.length;

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
      // Credit actions ignore purchases outside the credit catalog. A recovery
      // that cannot finish now retries on the next pass, and the refreshed
      // balance is the signal that it did.
      await creditActions.recoverPurchases(pendingPurchases, { notifyErrors: false });
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
  }, [creditActions, knownProductIdCount, signedIn, storefront]);

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
  useEffect(() => {
    if (signedIn && hasCreditProducts) {
      void recoverRef.current();
    }
  }, [hasCreditProducts, signedIn]);

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
