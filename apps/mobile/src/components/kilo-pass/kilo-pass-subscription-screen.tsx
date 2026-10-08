import * as Haptics from 'expo-haptics';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatNumber, formatUsd } from '@/lib/format';
import { useTRPC } from '@/lib/trpc';
import {
  getKiloPassPaidThrough,
  getKiloPassProviderDescription,
  getKiloPassStatusTitle,
  isLiveKiloPassSubscription,
  type KiloPassSubscription,
} from '@/lib/kilo-pass/subscription-card-state';
import { RestorePurchasesButton } from './restore-purchases-button';
import { useOwnedNativeKiloPass } from '@/lib/kilo-pass/use-owned-native-kilo-pass';

export function KiloPassSubscriptionScreen() {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useQuery(trpc.kiloPass.getState.queryOptions());
  const catalog = useQuery(trpc.kiloPass.getMobileStoreProducts.queryOptions());
  const subscription: KiloPassSubscription | null | undefined = state.data?.subscription;
  const paidThrough = subscription ? getKiloPassPaidThrough(subscription) : null;
  const ownedNative = useOwnedNativeKiloPass({
    appAccountToken: catalog.data?.appAccountToken,
    products: catalog.data?.products ?? [],
  });
  const canManagePrimary =
    subscription != null &&
    isLiveKiloPassSubscription(subscription) &&
    ((Platform.OS === 'ios' && subscription.paymentProvider === 'app_store') ||
      (Platform.OS === 'android' && subscription.paymentProvider === 'google_play'));
  const canManage = canManagePrimary || ownedNative.purchase !== null;
  const invalidateAfterManagement = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries({ queryKey: ['owned-native-kilo-pass'] }),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
    ]);
  };
  const manage = async () => {
    void Haptics.selectionAsync();
    // Store management modules load only on their native platform.
    if (Platform.OS === 'ios') {
      const { openAppStoreManagement } = await import('./kilo-pass-ios-manage');
      await openAppStoreManagement({ invalidateAfter: invalidateAfterManagement });
    } else if (Platform.OS === 'android') {
      const product = catalog.data?.products.find(item => item.tier === subscription?.tier);
      const skuAndroid = ownedNative.purchase?.productId ?? product?.googleProductId;
      const { openPlaySubscriptionManagement } = await import('./kilo-pass-play-manage');
      await openPlaySubscriptionManagement({
        ...(skuAndroid ? { skuAndroid } : {}),
        invalidateAfter: invalidateAfterManagement,
      });
    }
  };
  const bonus = subscription?.currentPeriodBonus;
  const bonusAmount =
    bonus?.status === 'issued' ? bonus.actualAmountUsd : bonus?.projectedAmountUsd;

  let statusContent: ReactNode = null;
  if (state.isPending) {
    statusContent = (
      <View
        accessibilityLabel={t('kiloPass.subscriptionLoading')}
        accessibilityState={{ busy: true }}
        className="gap-3 rounded-xl border border-border bg-card p-4"
      >
        <Skeleton className="h-5 w-48 rounded" />
        <Skeleton className="h-4 w-64 rounded" />
        <Skeleton className="h-4 w-40 rounded" />
      </View>
    );
  } else if (state.isError) {
    statusContent = (
      <View className="gap-3 rounded-xl border border-border bg-card p-4">
        <Text className="font-semibold">{t('kiloPass.unavailable')}</Text>
        <Text className="text-sm text-muted-foreground">{t('kiloPass.couldNotLoad')}</Text>
        <Button
          variant="outline"
          accessibilityLabel={t('kiloPass.retryLoading')}
          onPress={() => {
            void Haptics.selectionAsync();
            void state.refetch();
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  } else if (subscription) {
    statusContent = (
      <View className="gap-3 rounded-xl border border-border bg-card p-4">
        <Text className="font-semibold">{getKiloPassStatusTitle(subscription)}</Text>
        <Text className="text-sm text-muted-foreground">
          {getKiloPassProviderDescription(subscription)}
        </Text>
        <Text>
          {t('kiloPass.monthlyCredits', {
            credits: formatUsd(subscription.currentPeriodBaseCreditsUsd, i18n.language),
          })}
        </Text>
        {paidThrough ? <Text>{paidThrough}</Text> : null}
        <Text>
          {t('kiloPass.streakMonths', {
            months: formatNumber(subscription.currentStreakMonths, i18n.language),
          })}
        </Text>
        {bonusAmount != null ? (
          <Text>
            {t(bonus?.status === 'issued' ? 'kiloPass.bonusIssued' : 'kiloPass.bonusAvailable', {
              amount: formatUsd(bonusAmount, i18n.language),
            })}
          </Text>
        ) : null}
      </View>
    );
  } else {
    statusContent = (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-muted-foreground">{t('organization.kiloPass.notSubscribed')}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" testID="kilo-pass-status">
      <ScreenHeader title={t('kiloPass.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-4 px-1 pb-6"
        >
          {statusContent}
          {canManage && !canManagePrimary ? (
            <Text className="text-sm text-muted-foreground">
              {t(
                Platform.OS === 'ios'
                  ? 'kiloPass.managedInAppStore'
                  : 'kiloPass.managedOnGooglePlay'
              )}
            </Text>
          ) : null}
          {canManage ? (
            <Button
              variant="outline"
              accessibilityHint={t(
                Platform.OS === 'ios'
                  ? 'kiloPass.opensAppStoreManagement'
                  : 'kiloPass.opensPlayManagement'
              )}
              onPress={() => {
                void manage();
              }}
            >
              <Text>{t('kiloPass.manage')}</Text>
            </Button>
          ) : null}
          <RestorePurchasesButton />
        </DetailScreenScrollView>
      </View>
    </View>
  );
}
