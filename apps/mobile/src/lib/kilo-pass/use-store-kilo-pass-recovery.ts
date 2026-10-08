import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  restorePurchases,
} from 'expo-iap';
import { i18n } from '@/i18n';
import { useAuth } from '@/lib/auth/auth-context';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { withStoreDeadline } from '@/lib/iap/store-call-deadline';
import { useTRPC } from '@/lib/trpc';
import { getHistoricalKiloPassProductIds } from './historical-store-products';
import {
  createAppStoreKiloPassPurchaseActions,
  type StoreKiloPassRestorePurchasesResult,
} from './use-store-kilo-pass-purchase';

export type StoreKiloPassRecovery = {
  isRestoringPurchases: boolean;
  errorMessage: string | null;
  restorePurchases: () => Promise<StoreKiloPassRestorePurchasesResult | null>;
  signedIn: boolean;
};

// No useIAP owner or product lookup is required to restore a retired product.
// The app-wide recovery mount owns automatic unfinished-transaction recovery.
export function useStoreKiloPassRecovery(): StoreKiloPassRecovery {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { token, isLoading, isSigningOut } = useAuth();
  const signedIn = Boolean(token) && !isLoading && !isSigningOut;
  const epoch = currentAuthEpoch();
  const catalog = useQuery({
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    enabled: signedIn,
  });
  const apple = useMutation(trpc.kiloPass.completeAppStorePurchase.mutationOptions());
  const play = useMutation(trpc.kiloPass.completePlayPurchase.mutationOptions());
  const [isRestoringPurchases, setIsRestoringPurchases] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const actions = useMemo(() => {
    const ids = getHistoricalKiloPassProductIds(catalog.data?.products ?? []);
    return createAppStoreKiloPassPurchaseActions({
      appAccountToken: catalog.data?.appAccountToken ?? '',
      enabledAppleProductIds: ids.appleProductIds,
      enabledGoogleProductIds: ids.googleProductIds,
      getAvailablePurchases: async () => {
        const purchases = await withStoreDeadline(
          getAvailablePurchases(),
          'the subscription restore lookup'
        );
        return purchases;
      },
      restorePurchases: async () => {
        await withStoreDeadline(restorePurchases(), 'the subscription restore');
      },
      completeAppStorePurchase: apple.mutateAsync,
      completePlayPurchase: play.mutateAsync,
      finishTransaction,
      isAccountCurrent: () => isCurrentAuthEpoch(epoch),
      showError: setErrorMessage,
      invalidateAfterCompletion: async () => {
        if (!isCurrentAuthEpoch(epoch)) {
          return;
        }
        await Promise.all([
          queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
          queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
          queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
          queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
        ]);
      },
    });
  }, [apple.mutateAsync, play.mutateAsync, catalog.data, epoch, queryClient, trpc]);

  const restore = async (): Promise<StoreKiloPassRestorePurchasesResult | null> => {
    if (!signedIn || inFlight.current) {
      return null;
    }
    inFlight.current = true;
    setIsRestoringPurchases(true);
    setErrorMessage(null);
    try {
      await withStoreDeadline(initConnection(), 'the store connection');
      if (!isCurrentAuthEpoch(epoch)) {
        return null;
      }
      const result = await actions.restorePurchases();
      return isCurrentAuthEpoch(epoch) ? result : null;
    } catch {
      if (isCurrentAuthEpoch(epoch)) {
        setErrorMessage(i18n.t('kiloPass.restoreFailed'));
      }
      return isCurrentAuthEpoch(epoch) ? 'failed' : null;
    } finally {
      inFlight.current = false;
      if (isCurrentAuthEpoch(epoch)) {
        setIsRestoringPurchases(false);
      }
    }
  };

  return { isRestoringPurchases, errorMessage, restorePurchases: restore, signedIn };
}
