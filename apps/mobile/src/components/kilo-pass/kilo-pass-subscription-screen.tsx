import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';
import { useStoreKiloPassProducts } from '@/lib/kilo-pass/use-store-kilo-pass-products';
import { useStoreKiloPassPurchase } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';

function formatTier(product: AppStoreKiloPassProduct): string {
  return `$${product.webMonthlyPriceUsd} credits`;
}

function formatStorePrice(product: AppStoreKiloPassProduct): string {
  return `${product.displayPrice}/mo`;
}

export function KiloPassSubscriptionScreen() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const productsQuery = useStoreKiloPassProducts();
  const purchase = useStoreKiloPassPurchase();
  const handleProductPress = (product: AppStoreKiloPassProduct) => {
    void Haptics.selectionAsync();
    void purchase.purchase(product);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Kilo Pass" modal />
      <View className="flex-1 px-5">
        <ScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {productsQuery.isLoading &&
            [0, 1, 2].map(index => (
              <Skeleton key={index} className="h-[112px] w-full rounded-xl" />
            ))}

          {!productsQuery.isLoading && productsQuery.products.length === 0 && (
            <Pressable
              accessibilityRole="button"
              className="rounded-xl border border-border bg-card p-5 active:opacity-80"
              disabled={purchase.isPending}
              onPress={() => {
                void productsQuery.refetch();
              }}
            >
              <Text className="font-semibold text-foreground">App Store products unavailable</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {productsQuery.errorMessage ??
                  'Kilo Pass products could not be loaded from App Store.'}
              </Text>
              <Text className="mt-3 text-sm font-medium text-primary">Try again</Text>
            </Pressable>
          )}

          {!productsQuery.isLoading &&
            productsQuery.products.map(product => (
              <Pressable
                key={product.appleProductId}
                accessibilityRole="button"
                className="rounded-xl border border-border bg-card p-5 active:opacity-80"
                disabled={purchase.isPending}
                onPress={() => {
                  handleProductPress(product);
                }}
              >
                <View className="flex-row items-start justify-between gap-4">
                  <View className="flex-1 gap-1.5">
                    <Text className="font-semibold text-foreground">{formatTier(product)}</Text>
                    <Text className="text-xs text-muted-foreground">
                      Monthly Kilo Pass with bonus progress.
                    </Text>
                  </View>
                  <Text className="text-base font-semibold text-foreground tabular-nums">
                    {formatStorePrice(product)}
                  </Text>
                </View>
              </Pressable>
            ))}
        </ScrollView>

        {purchase.isPending && (
          <View style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
            <Button className="mt-4" disabled>
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}
