import { beginRefundRequestIOS, showManageSubscriptionsIOS, useIAP } from 'expo-iap';
import { type Href, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { WEB_BASE_URL } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';
import {
  getDevStoreKitRefundAppleProductId,
  requestDevStoreKitRefund,
} from '@/lib/kilo-pass/dev-storekit-refund';
import {
  getKiloPassSubscriptionCardState,
  shouldRenderKiloPassSubscriptionCard,
} from '@/lib/kilo-pass/subscription-card-state';
import { getAppStoreKiloPassOwnership } from '@/lib/kilo-pass/store-ownership';

const KILO_PASS_MANAGE_URL = `${WEB_BASE_URL}/subscriptions/kilo-pass`;

export function KiloPassSubscriptionCard() {
  const colors = useThemeColors();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const mobileStoreProductsQuery = useQuery({
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    enabled: Platform.OS === 'ios',
  });
  const [checkedAvailablePurchases, setCheckedAvailablePurchases] = useState(false);
  const { availablePurchases, connected, getAvailablePurchases } = useIAP({});

  useEffect(() => {
    if (Platform.OS !== 'ios' || !connected) {
      return;
    }

    const checkAvailablePurchases = async () => {
      setCheckedAvailablePurchases(false);
      try {
        await getAvailablePurchases();
      } catch {
        // Keep this profile-card probe quiet; purchase flows surface actionable errors.
      } finally {
        setCheckedAvailablePurchases(true);
      }
    };

    void checkAvailablePurchases();
  }, [connected, getAvailablePurchases]);

  const subscription = stateQuery.data?.subscription;
  const appStoreOwnership =
    Platform.OS !== 'ios'
      ? 'none'
      : !connected || !checkedAvailablePurchases || !mobileStoreProductsQuery.data
        ? 'checking'
        : getAppStoreKiloPassOwnership({
            appAccountToken: mobileStoreProductsQuery.data.appAccountToken,
            enabledAppleProductIds: mobileStoreProductsQuery.data.products.map(
              product => product.appleProductId
            ),
            purchases: availablePurchases,
          });
  const cardState = getKiloPassSubscriptionCardState(subscription, { appStoreOwnership });
  if (
    !shouldRenderKiloPassSubscriptionCard({
      action: cardState.action,
      platformOS: Platform.OS,
    })
  ) {
    return null;
  }

  const devRefundAppleProductId = getDevStoreKitRefundAppleProductId({
    products: mobileStoreProductsQuery.data?.products ?? [],
    subscription,
  });
  const invalidateKiloPassState = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
    ]);
  };
  const openAppStoreManagement = async () => {
    try {
      await showManageSubscriptionsIOS();
      await invalidateKiloPassState();
      setTimeout(() => {
        void invalidateKiloPassState();
      }, 2000);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to open App Store subscription management.'
      );
    }
  };
  const handlePress = () => {
    if (cardState.action === 'none') {
      return;
    }

    void Haptics.selectionAsync();
    if (cardState.action === 'open-web-management') {
      void Linking.openURL(KILO_PASS_MANAGE_URL);
      return;
    }
    if (cardState.action === 'open-store-management') {
      if (Platform.OS !== 'ios') {
        return;
      }
      void openAppStoreManagement();
      return;
    }
    router.push('/(app)/kilo-pass' as Href);
  };
  const handleDevRefundPress = () => {
    if (!devRefundAppleProductId) {
      return;
    }

    void Haptics.selectionAsync();
    void requestDevStoreKitRefund({
      appleProductId: devRefundAppleProductId,
      beginRefundRequest: beginRefundRequestIOS,
      invalidateAfterRefund: invalidateKiloPassState,
      showError: message => {
        toast.error(message);
      },
      showSuccess: message => {
        toast.success(message);
      },
    });
  };

  return (
    <View className="gap-2">
      {cardState.action === 'none' ? (
        <View className="rounded-lg border border-border bg-card p-3">
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <ShieldCheck size={19} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold">{cardState.title}</Text>
              <Text className="text-xs text-muted-foreground">{cardState.description}</Text>
            </View>
          </View>
        </View>
      ) : (
        <Pressable
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handlePress}
        >
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <ShieldCheck size={19} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold">{cardState.title}</Text>
              <Text className="text-xs text-muted-foreground">{cardState.description}</Text>
            </View>
            {cardState.actionLabel ? (
              <Text className="text-xs font-medium text-primary">{cardState.actionLabel}</Text>
            ) : null}
          </View>
        </Pressable>
      )}

      {devRefundAppleProductId ? (
        <Pressable
          accessibilityRole="button"
          className="rounded-lg border border-destructive bg-card px-3 py-2 active:opacity-80"
          onPress={handleDevRefundPress}
        >
          <Text className="text-center text-xs font-medium text-destructive">
            Dev: Request App Store refund
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
