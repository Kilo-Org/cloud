import { Check, X } from 'lucide-react-native';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';

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

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <Pressable className="absolute inset-0" onPress={onClose} />
        <View className="max-h-[86%] rounded-t-2xl bg-background px-4 pb-8 pt-4">
          <View className="mb-4 flex-row items-center justify-between">
            <View>
              <Text className="text-lg font-semibold">Kilo Pass</Text>
              <Text className="text-sm text-muted-foreground">App Store subscription</Text>
            </View>
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-md"
              onPress={onClose}
            >
              <X size={20} color={colors.foreground} />
            </Pressable>
          </View>

          <View className="gap-3">
            {isLoading &&
              [0, 1, 2].map(index => (
                <Skeleton key={index} className="h-[92px] w-full rounded-lg" />
              ))}

            {!isLoading &&
              products.map(product => (
                <Pressable
                  key={product.appleProductId}
                  className="rounded-lg border border-border bg-card p-3 active:opacity-80"
                  disabled={isPurchasing}
                  onPress={() => {
                    onPurchase(product);
                  }}
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-1">
                      <Text className="font-semibold">
                        {formatTier(product)} · {formatCadence(product)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        Same Kilo Pass credits and bonus progress as web.
                      </Text>
                    </View>
                    <Text className="text-sm font-semibold">{product.displayPrice}</Text>
                  </View>
                  <View className="mt-3 flex-row items-center gap-2">
                    <Check size={14} color={colors.good} />
                    <Text className="text-xs text-muted-foreground">
                      Credits are added after store validation.
                    </Text>
                  </View>
                </Pressable>
              ))}
          </View>

          <Button
            className="mt-4"
            disabled={isPurchasing}
            onPress={() => {
              const firstProduct = products[0];
              if (firstProduct) {
                onPurchase(firstProduct);
              }
            }}
          >
            {isPurchasing ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text>Continue</Text>
            )}
          </Button>
        </View>
      </View>
    </Modal>
  );
}
