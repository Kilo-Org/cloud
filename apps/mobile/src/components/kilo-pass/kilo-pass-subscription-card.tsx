import { showManageSubscriptionsIOS } from 'expo-iap';
import { type Href, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Linking, Platform, Pressable, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { WEB_BASE_URL } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';
import { getKiloPassSubscriptionCardState } from '@/lib/kilo-pass/subscription-card-state';

const KILO_PASS_MANAGE_URL = `${WEB_BASE_URL}/subscriptions/kilo-pass`;

export function KiloPassSubscriptionCard() {
  const colors = useThemeColors();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());

  if (Platform.OS !== 'ios') {
    return null;
  }

  const subscription = stateQuery.data?.subscription;
  const cardState = getKiloPassSubscriptionCardState(subscription);
  const openAppStoreManagement = async () => {
    try {
      await showManageSubscriptionsIOS();
      await queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter());
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to open App Store subscription management.'
      );
    }
  };
  const handlePress = () => {
    void Haptics.selectionAsync();
    if (cardState.action === 'open-web-management') {
      void Linking.openURL(KILO_PASS_MANAGE_URL);
      return;
    }
    if (cardState.action === 'open-store-management') {
      void openAppStoreManagement();
      return;
    }
    router.push('/(app)/kilo-pass' as Href);
  };

  return (
    <Pressable
      className="rounded-lg border border-border bg-card p-3 active:opacity-80"
      onPress={handlePress}
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
  );
}
