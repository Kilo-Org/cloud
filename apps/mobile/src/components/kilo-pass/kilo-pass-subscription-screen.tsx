import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getKiloPassLegalLinks, KILO_PASS_LEGAL_DISCLOSURE } from '@/lib/kilo-pass/legal-links';
import { ensureProfileAfterKiloPassPurchase } from '@/lib/kilo-pass/navigation';
import {
  formatKiloPassTierDescription,
  KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION,
} from '@/lib/kilo-pass/subscription-page-copy';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';
import { useStoreKiloPassProducts } from '@/lib/kilo-pass/use-store-kilo-pass-products';
import {
  useInlinePurchaseErrorOwnership,
  useStoreKiloPassPurchase,
} from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { cn } from '@/lib/utils';
import { RestorePurchasesButton } from './restore-purchases-button';

type SubscriptionScreenFeedback = { type: 'success' | 'info' | 'error'; text: string };

function formatTier(product: AppStoreKiloPassProduct): string {
  return `$${product.webMonthlyPriceUsd} in credits`;
}

function formatStorePrice(product: AppStoreKiloPassProduct): string {
  return `${product.displayPrice}/mo`;
}

export function KiloPassSubscriptionScreen() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const productsQuery = useStoreKiloPassProducts();
  const purchase = useStoreKiloPassPurchase();
  useInlinePurchaseErrorOwnership();
  const [restoreFeedback, setRestoreFeedback] = useState<SubscriptionScreenFeedback | null>(null);
  const feedback: SubscriptionScreenFeedback | null = purchase.errorMessage
    ? { type: 'error', text: purchase.errorMessage }
    : restoreFeedback;
  const isRetryDisabled = purchase.isPending || productsQuery.isRefetching;
  const [privacyPolicyLink, termsOfUseLink] = getKiloPassLegalLinks(WEB_BASE_URL);
  const { clearError } = purchase;
  useEffect(
    () => () => {
      clearError();
    },
    [clearError]
  );
  const handleProductPress = (product: AppStoreKiloPassProduct) => {
    void Haptics.selectionAsync();
    void purchase.purchase(product, {
      onCompleted: () => {
        ensureProfileAfterKiloPassPurchase(router);
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Kilo Pass" modal />
      <View className="flex-1 px-5">
        <DetailScreenScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1"
          showsVerticalScrollIndicator={false}
        >
          <Text className="px-1 text-sm leading-5 text-muted-foreground">
            {KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION}
          </Text>

          {feedback && (
            <Text
              className={cn('px-1 text-sm', {
                'text-destructive': feedback.type === 'error',
                'text-good': feedback.type === 'success',
                'text-muted-foreground': feedback.type === 'info',
              })}
            >
              {feedback.text}
            </Text>
          )}

          {productsQuery.isLoading &&
            [0, 1, 2].map(index => (
              <Skeleton key={index} className="h-[112px] w-full rounded-xl" />
            ))}

          {!productsQuery.isLoading && productsQuery.products.length === 0 && (
            <Pressable
              accessibilityLabel="Try loading Kilo Pass products again"
              accessibilityRole="button"
              accessibilityState={{
                busy: productsQuery.isRefetching,
                disabled: isRetryDisabled,
              }}
              className="rounded-xl border border-border bg-card p-5 active:opacity-80"
              disabled={isRetryDisabled}
              onPress={() => {
                void productsQuery.refetch();
              }}
            >
              <Text className="font-semibold text-foreground">App Store products unavailable</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {productsQuery.errorMessage ??
                  'Kilo Pass products could not be loaded from App Store.'}
              </Text>
              <Text className="mt-3 text-sm font-medium text-primary">
                {productsQuery.isRefetching ? 'Trying again...' : 'Try again'}
              </Text>
            </Pressable>
          )}

          {!productsQuery.isLoading &&
            productsQuery.products.map(product => (
              <Pressable
                key={product.appleProductId}
                accessibilityLabel={`${formatTier(product)}, ${formatStorePrice(product)}`}
                accessibilityRole="button"
                accessibilityState={{ busy: purchase.isPending, disabled: purchase.isPending }}
                className={cn(
                  'rounded-xl border border-border bg-card p-5 active:opacity-80',
                  purchase.isPending && 'opacity-50'
                )}
                disabled={purchase.isPending}
                onPress={() => {
                  handleProductPress(product);
                }}
              >
                <View className="flex-row items-start justify-between gap-4">
                  <View className="flex-1 gap-1.5">
                    <Text className="font-semibold text-foreground">{formatTier(product)}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {formatKiloPassTierDescription(product.webMonthlyPriceUsd)}
                    </Text>
                  </View>
                  <Text className="text-base font-semibold text-foreground tabular-nums">
                    {formatStorePrice(product)}
                  </Text>
                </View>
              </Pressable>
            ))}

          <RestorePurchasesButton
            onResult={result => {
              if (result === 'restored') {
                setRestoreFeedback({ type: 'success', text: 'Subscription restored.' });
              } else if (result === 'empty') {
                setRestoreFeedback({ type: 'info', text: 'No purchases to restore.' });
              } else {
                setRestoreFeedback(null);
              }
            }}
          />

          <Text className="px-1 pt-1 text-xs leading-5 text-muted-foreground">
            {KILO_PASS_LEGAL_DISCLOSURE}
            {' By subscribing, you agree to the '}
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(termsOfUseLink.url, { label: termsOfUseLink.label });
              }}
            >
              {termsOfUseLink.label}
            </Text>
            {' and acknowledge the '}
            <Text
              accessibilityRole="link"
              className="text-xs text-primary underline active:opacity-70"
              onPress={() => {
                void openExternalUrl(privacyPolicyLink.url, { label: privacyPolicyLink.label });
              }}
            >
              {privacyPolicyLink.label}
            </Text>
            .
          </Text>
        </DetailScreenScrollView>

        {purchase.isPending && (
          <View style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            <Button
              accessibilityLabel="Completing Kilo Pass purchase"
              accessibilityState={{ busy: true, disabled: true }}
              className="mt-4"
              disabled
            >
              <ActivityIndicator size="small" color={colors.primaryForeground} />
              <Text>Completing purchase</Text>
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}
