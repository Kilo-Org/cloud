import { useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

import { Text } from '@/components/ui/text';
import { KiloPassSubscriptionSheet } from '@/components/kilo-pass/kilo-pass-subscription-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { WEB_BASE_URL } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';
import { getKiloPassSubscriptionCardState } from '@/lib/kilo-pass/subscription-card-state';
import { useStoreKiloPassProducts } from '@/lib/kilo-pass/use-store-kilo-pass-products';
import { useStoreKiloPassPurchase } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';

const KILO_PASS_MANAGE_URL = `${WEB_BASE_URL}/subscriptions/kilo-pass`;

export function KiloPassSubscriptionCard() {
  const [sheetVisible, setSheetVisible] = useState(false);
  const colors = useThemeColors();
  const trpc = useTRPC();
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const productsQuery = useStoreKiloPassProducts();
  const purchase = useStoreKiloPassPurchase();

  if (Platform.OS !== 'ios') {
    return null;
  }

  const subscription = stateQuery.data?.subscription;
  const cardState = getKiloPassSubscriptionCardState(subscription);

  return (
    <>
      <Pressable
        className="rounded-lg border border-border bg-card p-3 active:opacity-80"
        onPress={() => {
          if (cardState.action === 'open-web-management') {
            void Linking.openURL(KILO_PASS_MANAGE_URL);
            return;
          }
          setSheetVisible(true);
        }}
      >
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-md bg-secondary">
            <ShieldCheck size={19} color={colors.primary} />
          </View>
          <View className="flex-1">
            <Text className="font-semibold">{cardState.title}</Text>
            <Text className="text-xs text-muted-foreground">{cardState.description}</Text>
          </View>
          <Text className="text-xs font-medium text-primary">{cardState.actionLabel}</Text>
        </View>
      </Pressable>

      <KiloPassSubscriptionSheet
        visible={sheetVisible}
        products={productsQuery.products}
        isLoading={productsQuery.isLoading}
        isPurchasing={purchase.isPending}
        onClose={() => {
          setSheetVisible(false);
        }}
        onPurchase={product => {
          void purchase.purchase(product);
        }}
      />
    </>
  );
}
