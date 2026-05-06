import { ShoppingBag, X } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAppleCreditProducts } from '@/lib/apple-iap/use-apple-credit-products';
import { useAppleCreditPurchase } from '@/lib/apple-iap/use-apple-credit-purchase';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AppleCreditDisplayProduct } from '@/lib/apple-iap/types';
import {
  formatAppleCreditAmount,
  getAppleCreditProductButtonText,
} from '@/components/apple-credit-purchase-utils';

type AppleCreditPurchaseSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPurchaseSuccess: () => void;
};

export function AppleCreditPurchaseSheet({
  visible,
  onClose,
  onPurchaseSuccess,
}: Readonly<AppleCreditPurchaseSheetProps>) {
  const colors = useThemeColors();
  const { products, isLoading, isError, refetch } = useAppleCreditProducts();
  const { purchaseProduct, isPending } = useAppleCreditPurchase();
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const handlePurchase = async (product: AppleCreditDisplayProduct) => {
    setActiveProductId(product.id);
    setPurchaseError(null);
    try {
      await purchaseProduct(product.id);
      toast.success(`${formatAppleCreditAmount(product.creditedCents)} added`);
      onPurchaseSuccess();
      onClose();
    } catch (error) {
      setPurchaseError(error instanceof Error ? error.message : 'Purchase failed. Try again.');
    } finally {
      setActiveProductId(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end" onPress={onClose}>
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          className="rounded-t-2xl bg-card px-5 pb-8 pt-4 gap-4"
          onPress={event => {
            event.stopPropagation();
          }}
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <ShoppingBag size={18} color={colors.foreground} />
              <Text className="text-base font-semibold">Buy Credits</Text>
            </View>
            <Button variant="ghost" size="icon" onPress={onClose} accessibilityLabel="Close">
              <X size={18} color={colors.mutedForeground} />
            </Button>
          </View>

          {isLoading && (
            <View className="h-28 items-center justify-center">
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            </View>
          )}

          {isError && (
            <Pressable
              className="rounded-lg bg-secondary p-3 active:opacity-70"
              onPress={() => {
                void refetch();
              }}
            >
              <Text className="text-sm text-destructive">
                Failed to load products. Tap to retry.
              </Text>
            </Pressable>
          )}

          {!isLoading && !isError && (
            <View className="gap-3">
              {products.map(product => {
                const isActive = activeProductId === product.id;
                return (
                  <Button
                    key={product.id}
                    variant="secondary"
                    className="h-auto items-start justify-between px-4 py-3"
                    disabled={isPending || activeProductId !== null}
                    onPress={() => {
                      void handlePurchase(product);
                    }}
                    accessibilityLabel={getAppleCreditProductButtonText(product)}
                  >
                    <View className="w-full flex-row items-center justify-between gap-3">
                      <View className="flex-1">
                        <Text className="font-semibold">
                          {formatAppleCreditAmount(product.creditedCents)}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          Pay {product.localizedPrice}
                        </Text>
                      </View>
                      {isActive && (
                        <ActivityIndicator size="small" color={colors.mutedForeground} />
                      )}
                    </View>
                  </Button>
                );
              })}
              {products.length === 0 && (
                <Text className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">
                  Credit packs are unavailable.
                </Text>
              )}
            </View>
          )}

          {purchaseError && (
            <Text className="rounded-lg bg-secondary p-3 text-sm text-destructive">
              {purchaseError}
            </Text>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
