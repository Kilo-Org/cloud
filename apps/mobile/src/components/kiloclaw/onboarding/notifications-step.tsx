import * as SecureStore from 'expo-secure-store';
import { ChevronRight } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { NOTIFICATION_PROMPT_SEEN_KEY } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

const MOCK_MESSAGE = 'All done! I put together that summary you asked for. Ready when you are.';

type NotificationsStepProps = {
  onComplete: () => void;
  botIdentity: BotIdentity | null;
};

export function NotificationsStep({ onComplete, botIdentity }: Readonly<NotificationsStepProps>) {
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { isActive } = useAppLifecycle();
  const [status, setStatus] = useState<'checking' | 'undetermined' | 'denied'>('checking');

  const botName = botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const botEmoji = botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  // Re-check permission on mount and whenever the app returns to foreground.
  // The user may have flipped the setting via the system Settings app after
  // we deep-linked them there; picking that up on resume avoids stranding
  // them on the "denied" state view.
  //
  // When permission is already granted (pre-granted, or flipped in Settings
  // after we deep-linked them there), we still need to fetch the Expo push
  // token and register it with the server — otherwise onboarding completes
  // without a server-registered token and the user never receives pushes.
  const registerTokenMutate = registerToken.mutate;
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      const permStatus = await getNotificationPermissionStatus();
      if (cancelled) {
        return;
      }
      if (permStatus === 'granted') {
        const token = await registerForPushNotifications();
        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- cancelled can change across awaits
        if (cancelled) {
          return;
        }
        if (token) {
          registerTokenMutate({ token, platform: getPlatform() });
        }
        await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- cancelled can change across awaits
        if (cancelled) {
          return;
        }
        onComplete();
      } else {
        setStatus(permStatus);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [isActive, onComplete, registerTokenMutate]);

  const handleEnable = useCallback(async () => {
    const currentStatus = await getNotificationPermissionStatus();

    if (currentStatus === 'denied') {
      Alert.alert(
        'Notifications Disabled',
        'To enable notifications, turn them on in your device settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
      return;
    }

    const token = await registerForPushNotifications();
    await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');

    if (token) {
      registerToken.mutate({ token, platform: getPlatform() });
    }

    onComplete();
  }, [onComplete, registerToken]);

  const handleSkip = useCallback(async () => {
    await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
    onComplete();
  }, [onComplete]);

  if (status === 'checking') {
    return null;
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 gap-6"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-2">
        <Text variant="eyebrow" className="text-xs">
          Notifications
        </Text>
        <Text className="text-2xl font-semibold">Stay in the loop</Text>
        <Text variant="muted" className="text-base">
          Get notified when {botName} finishes a task so you never miss a response.
        </Text>
      </View>

      <View className="rounded-2xl border border-border bg-card p-4">
        <View className="flex-row items-start gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-neutral-200 dark:bg-neutral-800">
            <Text className="text-xl">{botEmoji}</Text>
          </View>
          <View className="flex-1 gap-1">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold">{botName}</Text>
              <Text className="text-xs text-muted-foreground">now</Text>
            </View>
            <Text className="text-sm text-muted-foreground" numberOfLines={2}>
              {MOCK_MESSAGE}
            </Text>
          </View>
        </View>
      </View>

      <View className="gap-3">
        <Button size="lg" onPress={() => void handleEnable()}>
          <Text className="text-base">Enable notifications</Text>
          <ChevronRight size={16} color={colors.primaryForeground} />
        </Button>
        <Button variant="ghost" size="lg" onPress={() => void handleSkip()}>
          <Text className="text-base">Skip for now</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
