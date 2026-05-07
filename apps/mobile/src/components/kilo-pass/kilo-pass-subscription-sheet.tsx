import { Check, X } from 'lucide-react-native';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';

const KILO_PASS_INFO_URL = 'https://kilo.ai/features/kilo-pass';

type KiloPassSubscriptionSheetProps = {
  visible: boolean;
  products: AppStoreKiloPassProduct[];
  isLoading: boolean;
  isPurchasing: boolean;
  unavailableMessage: string | null;
  onClose: () => void;
  onPurchase: (product: AppStoreKiloPassProduct) => void;
  onRetry: () => void;
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
  unavailableMessage,
  onClose,
  onPurchase,
  onRetry,
}: Readonly<KiloPassSubscriptionSheetProps>) {
  const colors = useThemeColors();

  if (!visible) {
    return null;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
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

            {!isLoading && products.length === 0 && (
              <Pressable
                accessibilityRole="button"
                className="rounded-xl border border-border bg-card p-4 active:opacity-80"
                disabled={isPurchasing}
                onPress={onRetry}
              >
                <Text className="font-semibold text-foreground">
                  App Store products unavailable
                </Text>
                <Text className="mt-1 text-sm text-muted-foreground">
                  {unavailableMessage ?? 'Kilo Pass products could not be loaded from App Store.'}
                </Text>
                <Text className="mt-3 text-sm font-medium text-primary">Try again</Text>
              </Pressable>
            )}

            {!isLoading &&
              products.map(product => (
                <Pressable
                  key={product.appleProductId}
                  accessibilityRole="button"
                  className="rounded-xl border border-border bg-card p-4 active:opacity-80"
                  disabled={isPurchasing}
                  onPress={() => {
                    onPurchase(product);
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

          {isPurchasing && (
            <Button className="mt-4" disabled>
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            </Button>
          )}
        </View>
      </View>
    </Modal>
  );
}
