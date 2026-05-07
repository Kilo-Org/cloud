import { Check } from 'lucide-react-native';
import { ActivityIndicator, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';
import { useStoreKiloPassProducts } from '@/lib/kilo-pass/use-store-kilo-pass-products';
import { useStoreKiloPassPurchase } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';

const KILO_PASS_INFO_URL = 'https://kilo.ai/features/kilo-pass';

function formatTier(product: AppStoreKiloPassProduct): string {
  return `$${product.webMonthlyPriceUsd}/mo credits`;
}

function formatCadence(product: AppStoreKiloPassProduct): string {
  return product.cadence === 'yearly' ? 'Yearly' : 'Monthly';
}

export function KiloPassSubscriptionScreen() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const productsQuery = useStoreKiloPassProducts();
  const purchase = useStoreKiloPassPurchase();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Kilo Pass" modal />
      <View className="flex-1 px-5">
        <View className="mb-4 gap-1">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="How Kilo Pass works"
            hitSlop={8}
            onPress={() => {
              void Linking.openURL(KILO_PASS_INFO_URL);
            }}
          >
            <Text className="text-sm font-medium text-primary">How Kilo Pass works</Text>
          </Pressable>
          <Text className="text-sm text-muted-foreground">App Store subscription</Text>
        </View>

        <ScrollView
          className="-mx-1 flex-1"
          contentContainerClassName="gap-3 px-1 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {productsQuery.isLoading &&
            [0, 1, 2].map(index => <Skeleton key={index} className="h-[96px] w-full rounded-xl" />)}

          {!productsQuery.isLoading && productsQuery.products.length === 0 && (
            <Pressable
              accessibilityRole="button"
              className="rounded-xl border border-border bg-card p-4 active:opacity-80"
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
                className="rounded-xl border border-border bg-card p-4 active:opacity-80"
                disabled={purchase.isPending}
                onPress={() => {
                  void purchase.purchase(product);
                }}
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="font-semibold text-foreground">
                      {formatTier(product)} · {formatCadence(product)}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      Base credits plus monthly bonus progress.
                    </Text>
                  </View>
                  <View className="items-end gap-2">
                    <Text className="text-sm font-semibold text-foreground">
                      {product.displayPrice}
                    </Text>
                    <View className="h-5 w-5 items-center justify-center rounded-full border border-primary bg-primary">
                      <Check size={12} color={colors.primaryForeground} />
                    </View>
                  </View>
                </View>
                <View className="mt-3 flex-row items-center gap-2">
                  <Check size={14} color={colors.good} />
                  <Text className="text-xs text-muted-foreground">
                    Credits are added after store validation.
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
