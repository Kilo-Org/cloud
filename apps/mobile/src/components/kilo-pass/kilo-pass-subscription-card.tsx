import { type Href, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { AppState, Linking, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Text } from '@/components/ui/text';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { getDevStoreKitRefundAppleProductId } from '@/lib/kilo-pass/dev-storekit-refund';
import {
  getKiloPassSubscriptionCardAccessibility,
  getKiloPassSubscriptionCardContentState,
} from '@/lib/kilo-pass/subscription-card-state';

const GOOGLE_PRODUCT_ID_BY_TIER = {
  tier_19: 'kilopass_tier19',
  tier_49: 'kilopass_tier49',
  tier_199: 'kilopass_tier199',
} as const;

export function KiloPassSubscriptionCard() {
  const colors = useThemeColors();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
  const presentationQuery = useQuery(
    trpc.kiloPass.getPurchasePresentation.queryOptions({
      platform,
      storefront,
      product: 'kilo_pass',
      supportsNativePlayKiloPass: true,
    })
  );
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const mobileStoreProductsQuery = useQuery({
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    // Dev-only: the profile card needs App Store product IDs only to expose the
    // StoreKit refund sheet while testing sandbox refund/revocation flows.
    enabled: Platform.OS === 'ios' && __DEV__,
  });
  const subscription = stateQuery.data?.subscription;
  const contentState = getKiloPassSubscriptionCardContentState({
    presentation: presentationQuery.data,
    presentationIsError: presentationQuery.isError,
    presentationIsPending: presentationQuery.isPending,
    subscription,
    stateIsError: stateQuery.isError,
    stateIsPending: stateQuery.isPending,
    platformOS: Platform.OS,
  });

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

  // Returning to the app may follow a store-management trip (App Store or Play);
  // refetch both the presentation and state so the card reflects any change.
  const refetchRef = useRef({
    presentation: presentationQuery.refetch,
    state: stateQuery.refetch,
  });
  useEffect(() => {
    refetchRef.current = {
      presentation: presentationQuery.refetch,
      state: stateQuery.refetch,
    };
  }, [presentationQuery.refetch, stateQuery.refetch]);
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void refetchRef.current.presentation();
        void refetchRef.current.state();
      }
    });
    return () => {
      appStateSubscription.remove();
    };
  }, []);

  const handlePress = () => {
    if (contentState.kind !== 'card') {
      return;
    }

    const cardState = contentState.state;
    if (cardState.action === 'none') {
      return;
    }

    void Haptics.selectionAsync();
    if (cardState.action === 'open-web') {
      const webUrl = presentationQuery.data?.webUrl;
      if (webUrl) {
        void Linking.openURL(webUrl);
      }
      return;
    }
    if (cardState.action === 'open-store-management') {
      if (Platform.OS === 'android') {
        const tier = subscription?.tier;
        const skuAndroid =
          (tier != null
            ? GOOGLE_PRODUCT_ID_BY_TIER[tier as keyof typeof GOOGLE_PRODUCT_ID_BY_TIER]
            : undefined) ?? 'kilopass_tier19';
        void (async () => {
          const { openPlaySubscriptionManagement } = await import('./kilo-pass-play-manage');
          await openPlaySubscriptionManagement({
            skuAndroid,
            invalidateAfter: invalidateKiloPassState,
          });
        })();
        return;
      }
      void (async () => {
        const { openAppStoreManagement } = await import('./kilo-pass-ios-manage');
        await openAppStoreManagement({ invalidateAfter: invalidateKiloPassState });
      })();
      return;
    }
    router.push('/(app)/kilo-pass' as Href);
  };
  const handleRetryPress = () => {
    void Haptics.selectionAsync();
    void stateQuery.refetch();
    void presentationQuery.refetch();
  };
  const handleDevRefundPress = () => {
    if (!devRefundAppleProductId) {
      return;
    }

    void Haptics.selectionAsync();
    void (async () => {
      const { requestDevAppStoreRefund } = await import('./kilo-pass-ios-manage');
      requestDevAppStoreRefund({
        appleProductId: devRefundAppleProductId,
        invalidateAfterRefund: invalidateKiloPassState,
      });
    })();
  };

  const isUnavailable = presentationQuery.data?.kind === 'unavailable';

  return (
    <View className="gap-2">
      {contentState.kind === 'loading' ? (
        <View
          accessibilityLabel={t('kiloPass.subscriptionLoading')}
          accessibilityState={{ busy: true }}
          className="rounded-lg border border-border bg-card p-3"
        >
          <View className="flex-row items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-md" />
            <View className="flex-1 gap-1.5">
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-48 rounded" />
            </View>
          </View>
        </View>
      ) : null}

      {contentState.kind === 'error' ? (
        <Pressable
          accessibilityHint={t('kiloPass.retryHint')}
          accessibilityLabel={t('kiloPass.cardAccessibility', {
            title: contentState.title,
            description: contentState.description,
            actionLabel: contentState.actionLabel,
          })}
          accessibilityRole="button"
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handleRetryPress}
        >
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <KiloPassIcon size={19} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold">{contentState.title}</Text>
              <Text className="text-xs text-muted-foreground">{contentState.description}</Text>
            </View>
            <Text className="shrink-0 text-xs font-medium text-primary">
              {contentState.actionLabel}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {contentState.kind === 'card' && contentState.state.action === 'none' ? (
        <View className="rounded-lg border border-border bg-card p-3">
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <KiloPassIcon size={19} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold">{contentState.state.title}</Text>
              <Text className="text-xs text-muted-foreground">
                {contentState.state.description}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {contentState.kind === 'card' && contentState.state.action !== 'none' ? (
        <Pressable
          accessibilityHint={
            getKiloPassSubscriptionCardAccessibility(contentState.state, Platform.OS)
              .accessibilityHint
          }
          accessibilityLabel={
            getKiloPassSubscriptionCardAccessibility(contentState.state, Platform.OS)
              .accessibilityLabel
          }
          accessibilityRole="button"
          className="rounded-lg border border-border bg-card p-3 active:opacity-80"
          onPress={handlePress}
          testID={isUnavailable ? 'kilo-pass-unavailable-card' : undefined}
        >
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <KiloPassIcon size={19} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold">{contentState.state.title}</Text>
              <Text className="text-xs text-muted-foreground">
                {contentState.state.description}
              </Text>
            </View>
            {contentState.state.actionLabel ? (
              <Text className="shrink-0 text-xs font-medium text-primary">
                {contentState.state.actionLabel}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ) : null}

      {devRefundAppleProductId ? (
        <Pressable
          accessibilityRole="button"
          className="rounded-lg border border-destructive bg-card px-3 py-2 active:opacity-80"
          onPress={handleDevRefundPress}
        >
          <Text className="text-center text-xs font-medium text-destructive">
            {t('kiloPass.devRefund')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
