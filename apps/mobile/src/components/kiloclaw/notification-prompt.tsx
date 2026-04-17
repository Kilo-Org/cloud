import { Bell } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { NOTIFICATION_PROMPT_SEEN_KEY } from '@/lib/storage-keys';
import { useTRPC } from '@/lib/trpc';

export function NotificationPrompt({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);
  const colors = useThemeColors();
  const trpc = useTRPC();

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    async function check() {
      const seen = await SecureStore.getItemAsync(NOTIFICATION_PROMPT_SEEN_KEY);
      if (seen) {
        return;
      }

      const status = await getNotificationPermissionStatus();
      if (status === 'granted') {
        return;
      }

      setVisible(true);
    }
    void check();
  }, [enabled]);

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

    const result = await Notifications.requestPermissionsAsync();
    if (result.status !== Notifications.PermissionStatus.GRANTED) {
      return;
    }

    await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
    setVisible(false);

    const token = await registerForPushNotifications();
    if (token) {
      registerToken.mutate(
        { token, platform: getPlatform() },
        {
          onSuccess: () => {
            toast.success('Notifications enabled');
          },
        }
      );
    }
  }, [registerToken]);

  const handleDismiss = useCallback(async () => {
    await SecureStore.setItemAsync(NOTIFICATION_PROMPT_SEEN_KEY, 'true');
    setVisible(false);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
      <View className="mx-3 mb-2 flex-row items-center gap-3 rounded-xl bg-secondary p-4">
        <Bell size={20} color={colors.foreground} />
        <View className="flex-1">
          <Text className="text-sm font-medium">Get notified when Kilo replies</Text>
          <Text variant="muted" className="text-xs">
            We'll send a push notification so you don't miss anything.
          </Text>
        </View>
        <View className="flex-row gap-2">
          <Button variant="ghost" size="sm" onPress={() => void handleDismiss()}>
            <Text className="text-xs text-muted-foreground">Later</Text>
          </Button>
          <Button size="sm" onPress={() => void handleEnable()}>
            <Text className="text-xs text-primary-foreground">Enable</Text>
          </Button>
        </View>
      </View>
    </Animated.View>
  );
}
