/* eslint-disable max-lines -- The Buy credits screen composes the store banner, loading, empty, error, and pack-row surfaces; each is a small rendered surface that mirrors the shared header/scroll pattern. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { type StoreCreditProduct } from '@/lib/credits/store-products';
import { useStoreCreditProducts } from '@/lib/credits/use-store-credit-products';
import { useInlinePurchaseErrorOwnership } from '@/lib/credits/use-store-credit-purchase';
import { openExternalUrl } from '@/lib/external-link';
import { formatMoney, formatUsd } from '@/lib/format';
import { getStoreLegalLinks } from '@/lib/kilo-pass/legal-links';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useCreditNativeIap } from './credit-native-iap-owner';

/** Reserved pack-row space while the store connects, so rows never jump in. */
const PACK_SKELETON_ROWS = 4;

/**
 * One-off credit packs bought with the store's own purchase sheet.
 *
 * The stores sell fixed SKUs, not an arbitrary amount, so the catalog is the
 * four preset amounts. Every row renders the backend amount; the store's
 * localized price appears when the store priced that pack, and a row the store
 * cannot price is disabled (its purchase would be unbillable).
 */
export function CreditPurchaseScreen() {
  const { t, i18n } = useTranslation();
  const isAndroid = Platform.OS === 'android';
  const trpc = useTRPC();
  const {
    connected,
    fetchStoreProducts,
    purchase,
    completingProductId,
    errorMessageKey: purchaseErrorMessageKey,
    completedPurchaseCount,
    clearError,
  } = useCreditNativeIap();
  const {
    products,
    isLoading,
    isRefetching,
    storeUnavailable,
    errorMessageKey: productsErrorMessageKey,
    refetch,
  } = useStoreCreditProducts({ connected, fetchStoreProducts });
  // The screen renders purchase errors inline, so they must not also toast.
  useInlinePurchaseErrorOwnership();

  const balanceQuery = useQuery({
    ...trpc.user.getContextBalance.queryOptions({}),
    placeholderData: keepPreviousData,
  });
  const refetchBalance = balanceQuery.refetch;

  const [privacyPolicyLink, termsOfUseLink] = getStoreLegalLinks(WEB_BASE_URL);

  // A granted purchase bumps the owner's counter; a cancelled one releases the
  // request with no error key, so the counter is the only success signal.
  const completedPurchaseCountRef = useRef(completedPurchaseCount);
  useEffect(() => {
    if (completedPurchaseCount <= completedPurchaseCountRef.current) {
      return;
    }
    completedPurchaseCountRef.current = completedPurchaseCount;
    toast.success(t('credits.purchased'));
    void refetchBalance();
  }, [completedPurchaseCount, refetchBalance, t]);

  const purchasing = completingProductId !== null;
  const packsEmpty = !isLoading && !storeUnavailable && products.length === 0;
  const balancePending = balanceQuery.isPending;
  const balanceFailed = balanceQuery.isError;
  const storeBannerBodyKey =
    productsErrorMessageKey ??
    (isAndroid ? 'credits.noMatchingProductsPlay' : 'credits.noMatchingProducts');

  const handlePackPress = (pack: StoreCreditProduct) => {
    void Haptics.selectionAsync();
    clearError();
    void purchase(pack);
  };

  const renderBalanceValue = () => {
    if (balancePending) {
      return <Skeleton className="mt-1 h-7 w-24 rounded" />;
    }
    if (balanceFailed) {
      return (
        <Pressable
          accessibilityLabel={t('profile.failedToLoadBalance')}
          accessibilityRole="button"
          className="min-h-11 justify-center active:opacity-70"
          onPress={() => {
            void refetchBalance();
          }}
        >
          <Text className="text-sm text-destructive">{t('profile.failedToLoadBalance')}</Text>
        </Pressable>
      );
    }
    return (
      <Text className="text-2xl font-bold tabular-nums">
        {formatMoney(balanceQuery.data.balance, i18n.language)}
      </Text>
    );
  };

  return (
    <View className="flex-1 bg-background" testID="credit-purchase-screen">
      <ScreenHeader title={t('credits.title')} modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <View className="min-h-16 justify-center rounded-xl border border-border bg-card px-5 py-4">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profile.credits')}
            </Text>
            {renderBalanceValue()}
          </View>

          {/* The purchase error is rendered inline (the store sheet has just
              dismissed), so no toast accompanies it. AccessibleStatus is the
              one announcement channel that survives that: a polite live
              region on Android and an imperative announcement on iOS. A plain
              Text left a screen-reader user with no failure feedback at all. */}
          <AccessibleStatus
            message={purchaseErrorMessageKey ? t(purchaseErrorMessageKey) : null}
            className="px-1 text-sm"
          />

          {storeUnavailable && (
            <View className="gap-3 rounded-xl border border-border bg-card p-5">
              <Text className="font-semibold text-foreground">
                {t(isAndroid ? 'kiloPass.productsUnavailablePlay' : 'kiloPass.productsUnavailable')}
              </Text>
              <Text className="text-sm text-muted-foreground">{t(storeBannerBodyKey)}</Text>
              <Button
                accessibilityLabel={t('common.tryAgain')}
                accessibilityState={{ busy: isRefetching, disabled: isRefetching }}
                className="self-start"
                disabled={isRefetching}
                onPress={() => {
                  void refetch();
                }}
                variant="outline"
              >
                <Text>{t('common.tryAgain')}</Text>
              </Button>
            </View>
          )}

          {packsEmpty && (
            <View className="rounded-xl border border-border bg-card p-5">
              <Text className="text-sm text-muted-foreground">{t('credits.empty')}</Text>
            </View>
          )}

          {isLoading &&
            Array.from({ length: PACK_SKELETON_ROWS }, (_, index) => (
              // Mirror the pack row's own shell (p-5 + one text-base line) so
              // the placeholder and the row it swaps with are the same height.
              // Kilo Pass's 112px placeholder is two lines tall; reusing it
              // here would drop the legal copy ~192px when the rows arrive.
              <View key={index} className="rounded-xl border border-border bg-card p-5">
                <View className="flex-row items-start justify-between gap-4">
                  <Skeleton className="h-6 flex-1 rounded" />
                  <Skeleton className="h-6 w-16 rounded" />
                </View>
              </View>
            ))}

          {!isLoading &&
            products.map(pack => {
              const packLabel = t('credits.packLabel', {
                amount: formatUsd(pack.backend.amountUsd, i18n.language),
              });
              const hasStorePrice = pack.storeProductId !== null && pack.displayPrice !== null;
              const rowCompleting =
                completingProductId !== null && completingProductId === pack.storeProductId;
              const disabled = purchasing || !hasStorePrice;
              const priceLabel = rowCompleting
                ? t('kiloPass.completingPurchase')
                : (pack.displayPrice ?? t('credits.priceUnavailable'));
              // The row is one accessible element: the explicit label replaces
              // its children, so the charge and the disabled reason must be in
              // the label itself (the canonical Kilo Pass row does the same).
              const rowAccessibilityLabel = [packLabel, priceLabel].join(', ');

              return (
                <Pressable
                  key={pack.backend.appleProductId}
                  accessibilityLabel={rowAccessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ busy: rowCompleting, disabled }}
                  className={cn(
                    'rounded-xl border border-border bg-card p-5 active:opacity-80',
                    disabled && 'opacity-50'
                  )}
                  disabled={disabled}
                  onPress={() => {
                    handlePackPress(pack);
                  }}
                >
                  <View className="flex-row items-start justify-between gap-4">
                    <Text className="flex-1 font-semibold text-foreground">{packLabel}</Text>
                    <Text className="text-base font-semibold text-foreground tabular-nums">
                      {priceLabel}
                    </Text>
                  </View>
                </Pressable>
              );
            })}

          {/* Do not set a leading class here. Android applies the parent line
              height to each nested link Text and the block grows to many times
              its size. */}
          <Text className="px-1 pt-1 text-xs text-muted-foreground">
            {t('credits.description')}
          </Text>
          <View className="flex-row flex-wrap items-center gap-4 px-1">
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(termsOfUseLink.url, { label: termsOfUseLink.label });
              }}
            >
              {termsOfUseLink.label}
            </Text>
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(privacyPolicyLink.url, { label: privacyPolicyLink.label });
              }}
            >
              {privacyPolicyLink.label}
            </Text>
          </View>
        </DetailScreenScrollView>
      </View>
    </View>
  );
}
