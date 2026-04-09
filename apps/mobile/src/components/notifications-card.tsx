import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

export function NotificationsCard() {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(true);

  const { data: pushTokens } = useQuery(trpc.user.getMyPushTokens.queryOptions());

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onSuccess: () => {
        toast.success('Notifications enabled');
      },
      onError: error => {
        setNotificationsEnabled(false);
        toast.error(error.message);
      },
    })
  );

  const unregisterToken = useMutation(
    trpc.user.unregisterPushToken.mutationOptions({
      onSuccess: () => {
        toast.success('Notifications disabled');
        setNotificationsEnabled(false);
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  useEffect(() => {
    async function checkStatus() {
      const status = await getNotificationPermissionStatus();
      const hasTokens = (pushTokens?.length ?? 0) > 0;
      setNotificationsEnabled(status === 'granted' && hasTokens);
      setNotificationsLoading(false);
    }
    void checkStatus();
  }, [pushTokens]);

  const handleToggleNotifications = useCallback(
    async (value: boolean) => {
      if (value) {
        const status = await getNotificationPermissionStatus();
        if (status === 'denied') {
          Alert.alert(
            'Notifications Disabled',
            'To enable notifications, open your device settings and allow notifications for Kilo.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => void Linking.openSettings() },
            ]
          );
          return;
        }

        const token = await registerForPushNotifications();
        if (token) {
          registerToken.mutate({ token, platform: getPlatform() });
          setNotificationsEnabled(true);
        }
      } else {
        const deviceToken = await getDevicePushToken();
        if (deviceToken) {
          unregisterToken.mutate({ token: deviceToken });
        } else {
          // Token unavailable (e.g. permission revoked) — update UI to match
          setNotificationsEnabled(false);
        }
      }
    },
    [registerToken, unregisterToken]
  );

  return (
    <View className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        Notifications
      </Text>
      <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
        <Bell size={18} color={colors.secondaryForeground} />
        <Text className="flex-1 text-sm font-medium">Push Notifications</Text>
        {notificationsLoading ? (
          <Skeleton className="h-8 w-12 rounded-full" />
        ) : (
          <Switch
            value={notificationsEnabled}
            disabled={registerToken.isPending || unregisterToken.isPending}
            onValueChange={value => void handleToggleNotifications(value)}
          />
        )}
      </View>
    </View>
  );
}
