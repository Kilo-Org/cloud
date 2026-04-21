import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, MessageSquare } from 'lucide-react-native';
import { useCallback, useEffect, useRef } from 'react';
import { Alert, Linking, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import * as Notifications from 'expo-notifications';

import {
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

const permissionQueryKey = ['notificationPermission'];
const deviceTokenQueryKey = ['devicePushToken'];

export function NotificationsCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();

  const { data: permissionGranted = false, isLoading: permissionLoading } = useQuery({
    queryKey: permissionQueryKey,
    queryFn: async () => {
      const status = await getNotificationPermissionStatus();
      return status === 'granted';
    },
  });

  const { data: deviceToken, isLoading: deviceTokenLoading } = useQuery({
    queryKey: deviceTokenQueryKey,
    queryFn: getDevicePushToken,
    enabled: permissionGranted,
  });

  const { data: pushTokens, isLoading: tokensLoading } = useQuery(
    trpc.user.getMyPushTokens.queryOptions()
  );

  const pushTokensQueryKey = trpc.user.getMyPushTokens.queryOptions().queryKey;
  const serverRegistered =
    deviceToken != null && (pushTokens ?? []).some(t => t.token === deviceToken);

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pushTokensQueryKey });
  }, [queryClient, pushTokensQueryKey]);

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: pushTokensQueryKey });
        const previous = queryClient.getQueryData(pushTokensQueryKey);
        // Optimistically add the device token to the list
        if (deviceToken) {
          queryClient.setQueryData(pushTokensQueryKey, (old: typeof pushTokens) => [
            ...(old ?? []),
            { token: deviceToken, platform: getPlatform() },
          ]);
        }
        return { previous };
      },
      onError: (error, _vars, context) => {
        if (context?.previous) {
          queryClient.setQueryData(pushTokensQueryKey, context.previous);
        }
        toast.error(error.message);
      },
      onSettled: invalidateAll,
    })
  );

  const unregisterToken = useMutation(
    trpc.user.unregisterPushToken.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: pushTokensQueryKey });
        const previous = queryClient.getQueryData(pushTokensQueryKey);
        // Optimistically remove the device token from the list
        if (deviceToken) {
          queryClient.setQueryData(pushTokensQueryKey, (old: typeof pushTokens) =>
            (old ?? []).filter(t => t.token !== deviceToken)
          );
        }
        return { previous };
      },
      onError: (error, _vars, context) => {
        if (context?.previous) {
          queryClient.setQueryData(pushTokensQueryKey, context.previous);
        }
        toast.error(error.message);
      },
      onSettled: invalidateAll,
    })
  );

  // Re-check permission on foreground resume
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!wasActiveRef.current && isActive) {
      void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
    }
    wasActiveRef.current = isActive;
  }, [isActive, queryClient]);

  const handleToggleNotifications = useCallback(
    async (value: boolean) => {
      if (value) {
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
        await Notifications.requestPermissionsAsync();
        void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
      } else {
        Alert.alert(
          'Disable Notifications',
          'To disable notifications, turn them off in your device settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ]
        );
      }
    },
    [queryClient]
  );

  const handleToggleChatMessages = useCallback(
    async (value: boolean) => {
      if (value) {
        const token = await registerForPushNotifications();
        if (token) {
          registerToken.mutate({ token, platform: getPlatform() });
        }
      } else if (deviceToken) {
        unregisterToken.mutate({ token: deviceToken });
      }
    },
    [registerToken, unregisterToken, deviceToken]
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
        {permissionLoading ? (
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
        {permissionLoading || tokensLoading || deviceTokenLoading ? (
          <Skeleton className="h-8 w-12 rounded-full" />
        ) : (
          <Switch
            value={serverRegistered}
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
