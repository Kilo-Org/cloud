import { Portal } from '@rn-primitives/portal';
import { Check, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';

type KiloPassSubscriptionSheetProps = {
  visible: boolean;
  products: AppStoreKiloPassProduct[];
  isLoading: boolean;
  isPurchasing: boolean;
  onClose: () => void;
  onPurchase: (product: AppStoreKiloPassProduct) => void;
};

function formatTier(product: AppStoreKiloPassProduct): string {
  return `$${product.webMonthlyPriceUsd}/mo credits`;
}

function formatCadence(product: AppStoreKiloPassProduct): string {
  return product.cadence === 'yearly' ? 'Yearly' : 'Monthly';
}

export function KiloPassSubscriptionSheet({
  visible,
  products,
  isLoading,
  isPurchasing,
  onClose,
  onPurchase,
}: Readonly<KiloPassSubscriptionSheetProps>) {
  const colors = useThemeColors();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const selectedProduct = useMemo(
    () => products.find(product => product.appleProductId === selectedProductId) ?? products[0],
    [products, selectedProductId]
  );

  useEffect(() => {
    if (selectedProductId === null && products[0]) {
      setSelectedProductId(products[0].appleProductId);
    }
  }, [products, selectedProductId]);

  if (!visible) {
    return null;
  }

  return (
    <Portal name="kilo-pass-subscriptions">
      <View className="absolute inset-0 justify-end bg-black/40">
        <Pressable
          className="flex-1"
          accessibilityLabel="Close Kilo Pass subscriptions"
          onPress={onClose}
        />
        <View className="max-h-[88%] rounded-t-3xl bg-background px-5 pb-8 pt-3">
          <View className="items-center pb-3">
            <View className="h-1 w-10 rounded-full bg-muted" />
          </View>

          <View className="mb-4 flex-row items-start justify-between gap-3">
            <View className="flex-1 gap-1">
              <Text className="text-xl font-semibold text-foreground">Kilo Pass</Text>
              <Text className="text-sm text-muted-foreground">App Store subscription</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Kilo Pass subscriptions"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
              onPress={onClose}
            >
              <X size={18} color={colors.foreground} />
            </Pressable>
          </View>

          <ScrollView
            className="-mx-1"
            contentContainerClassName="gap-3 px-1 pb-2"
            showsVerticalScrollIndicator={false}
          >
            {isLoading &&
              [0, 1, 2].map(index => (
                <Skeleton key={index} className="h-[96px] w-full rounded-xl" />
              ))}

            {!isLoading &&
              products.map(product => {
                const selected = product.appleProductId === selectedProduct?.appleProductId;

                return (
                  <Pressable
                    key={product.appleProductId}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    className={`rounded-xl border p-4 active:opacity-80 ${
                      selected ? 'border-primary bg-secondary' : 'border-border bg-card'
                    }`}
                    disabled={isPurchasing}
                    onPress={() => {
                      setSelectedProductId(product.appleProductId);
                    }}
                  >
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1 gap-1">
                        <Text className="font-semibold text-foreground">
                          {formatTier(product)} · {formatCadence(product)}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          Same Kilo Pass credits and bonus progress as web.
                        </Text>
                      </View>
                      <View className="items-end gap-2">
                        <Text className="text-sm font-semibold text-foreground">
                          {product.displayPrice}
                        </Text>
                        <View
                          className={`h-5 w-5 items-center justify-center rounded-full border ${
                            selected ? 'border-primary bg-primary' : 'border-border'
                          }`}
                        >
                          {selected && <Check size={12} color={colors.primaryForeground} />}
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
                );
              })}
          </ScrollView>

          <Button
            className="mt-4"
            disabled={isPurchasing || !selectedProduct}
            onPress={() => {
              if (selectedProduct) {
                onPurchase(selectedProduct);
              }
            }}
          >
            {isPurchasing ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text>
                {selectedProduct ? `Subscribe for ${selectedProduct.displayPrice}` : 'Subscribe'}
              </Text>
            )}
          </Button>
        </View>
      </View>
    </Portal>
  );
}
