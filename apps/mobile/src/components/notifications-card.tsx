import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, MessageSquare } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import * as Notifications from 'expo-notifications';

import {
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

export function NotificationsCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [loading, setLoading] = useState(true);

  const { data: pushTokens } = useQuery(trpc.user.getMyPushTokens.queryOptions());
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const serverRegistered =
    deviceToken != null && (pushTokens ?? []).some(t => t.token === deviceToken);

  // Optimistic override — null means "use server state"
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const thisDeviceRegistered = optimistic ?? serverRegistered;

  // Sync optimistic state back to server state once query catches up
  useEffect(() => {
    if (optimistic != null && optimistic === serverRegistered) {
      setOptimistic(null);
    }
  }, [optimistic, serverRegistered]);

  // Fetch current device's token once permission is known
  useEffect(() => {
    if (!permissionGranted) {
      return;
    }
    async function fetch() {
      setDeviceToken(await getDevicePushToken());
    }
    void fetch();
  }, [permissionGranted]);

  const invalidateTokens = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.user.getMyPushTokens.queryOptions().queryKey,
    });
  }, [queryClient, trpc]);

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onSuccess: () => {
        invalidateTokens();
      },
      onError: error => {
        setOptimistic(null);
        toast.error(error.message);
      },
    })
  );

  const unregisterToken = useMutation(
    trpc.user.unregisterPushToken.mutationOptions({
      onSuccess: () => {
        invalidateTokens();
      },
      onError: error => {
        setOptimistic(null);
        toast.error(error.message);
      },
    })
  );

  // Check system permission on mount and foreground resume
  const checkPermission = useCallback(async () => {
    const status = await getNotificationPermissionStatus();
    setPermissionGranted(status === 'granted');
    setLoading(false);
  }, []);

  useEffect(() => {
    void checkPermission();
  }, [checkPermission]);

  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (/inactive|background/.exec(appState.current) && nextAppState === 'active') {
        void checkPermission();
      }
      appState.current = nextAppState;
    });
    return () => {
      subscription.remove();
    };
  }, [checkPermission]);

  const handleToggleNotifications = useCallback(async (value: boolean) => {
    if (value) {
      const currentStatus = await getNotificationPermissionStatus();
      if (currentStatus === 'denied') {
        // Already denied once — OS won't show the prompt again, must go to Settings
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
      // Undetermined — triggers the OS permission prompt
      const result = await Notifications.requestPermissionsAsync();
      setPermissionGranted(result.status === Notifications.PermissionStatus.GRANTED);
    } else {
      // Can't revoke permission programmatically — send user to Settings
      Alert.alert(
        'Disable Notifications',
        'To disable notifications, turn them off in your device settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
    }
  }, []);

  const handleToggleChatMessages = useCallback(
    async (value: boolean) => {
      setOptimistic(value);
      if (value) {
        const token = await registerForPushNotifications();
        if (token) {
          registerToken.mutate({ token, platform: getPlatform() });
        } else {
          setOptimistic(null);
        }
      } else {
        const token = await getDevicePushToken();
        if (token) {
          unregisterToken.mutate({ token });
        } else {
          setOptimistic(null);
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

      {/* System permission toggle */}
      <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
        <Bell size={18} color={colors.secondaryForeground} />
        <Text className="flex-1 text-sm font-medium">Notifications</Text>
        {loading ? (
          <Skeleton className="h-8 w-12 rounded-full" />
        ) : (
          <Switch
            value={permissionGranted}
            onValueChange={value => void handleToggleNotifications(value)}
          />
        )}
      </View>

      {/* Chat messages — controls DB token registration */}
      <View
        className={`flex-row items-center gap-3 rounded-lg bg-secondary p-3 ${!permissionGranted ? 'opacity-40' : ''}`}
      >
        <MessageSquare size={18} color={colors.secondaryForeground} />
        <Text className="flex-1 text-sm font-medium">Chat Messages</Text>
        {loading ? (
          <Skeleton className="h-8 w-12 rounded-full" />
        ) : (
          <Switch
            value={thisDeviceRegistered}
            disabled={!permissionGranted}
            onValueChange={value => {
              if (registerToken.isPending || unregisterToken.isPending) {
                return;
              }
              void handleToggleChatMessages(value);
            }}
          />
        )}
      </View>
    </View>
  );
}
