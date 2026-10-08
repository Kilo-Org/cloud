import { useQuery } from '@tanstack/react-query';
import { getAvailablePurchases, initConnection } from 'expo-iap';
import { Platform } from 'react-native';
import { useAuth } from '@/lib/auth/auth-context';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { withStoreDeadline } from '@/lib/iap/store-call-deadline';
import { getHistoricalKiloPassProductIds } from './historical-store-products';

type Products = Parameters<typeof getHistoricalKiloPassProductIds>[0];

// Store evidence exposes management only. The backend still owns all benefits.
export function useOwnedNativeKiloPass(params: {
  appAccountToken: string | undefined;
  products: Products;
}) {
  const { token, isLoading, isSigningOut } = useAuth();
  const epoch = currentAuthEpoch();
  const enabled =
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    Boolean(token && params.appAccountToken) &&
    !isLoading &&
    !isSigningOut;
  const query = useQuery({
    queryKey: ['owned-native-kilo-pass', epoch, params.appAccountToken],
    enabled,
    queryFn: async () => {
      await withStoreDeadline(initConnection(), 'the subscription management connection');
      if (!isCurrentAuthEpoch(epoch)) {
        return [];
      }
      const purchases = await withStoreDeadline(
        getAvailablePurchases({ onlyIncludeActiveItemsIOS: true }),
        'the subscription management lookup'
      );
      return isCurrentAuthEpoch(epoch) ? purchases : [];
    },
  });
  const ids = getHistoricalKiloPassProductIds(params.products);
  const purchase =
    enabled && isCurrentAuthEpoch(epoch)
      ? (query.data?.find(item => {
          if (item.purchaseState !== 'purchased') {
            return false;
          }
          if (Platform.OS === 'ios' && item.store === 'apple' && 'appAccountToken' in item) {
            return (
              ids.appleProductIds.includes(item.productId) &&
              item.appAccountToken?.toLowerCase() === params.appAccountToken?.toLowerCase() &&
              (item.expirationDateIOS ?? 0) > Date.now()
            );
          }
          if (
            Platform.OS === 'android' &&
            item.store === 'google' &&
            'obfuscatedAccountIdAndroid' in item
          ) {
            // Play's current purchase set includes canceled-but-unexpired periods.
            return (
              ids.googleProductIds.includes(item.productId) &&
              item.obfuscatedAccountIdAndroid === params.appAccountToken &&
              item.isSuspendedAndroid !== true
            );
          }
          return false;
        }) ?? null)
      : null;
  return { purchase };
}
