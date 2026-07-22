/* eslint-disable max-lines -- The dedicated Notifications screen composes the master
 * OS-permission gate, the push-token registration flow, and 5 per-category toggles
 * with their optimistic-mutation + retry + loading patterns. Extracting subcomponents
 * would re-encode the same hooks. The screen stays a single rendered surface. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import {
  Bell,
  BellOff,
  Bot,
  CircleCheck,
  KeyRound,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  RefreshCw,
  Sparkles,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import {
  applyAgentPushOptimistic,
  deriveAgentPushEditable,
  deriveShowEnableCta,
  type NotificationCategoryKey,
  type NotificationPreferences,
  readAgentPushPreference,
  rollbackAgentPushOptimistic,
} from '@/lib/hooks/agent-push-preference';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

const permissionQueryKey = ['notificationPermission'] as const;
const deviceTokenQueryKey = ['devicePushToken'] as const;

type InlineRetryProps = Readonly<{ label: string; color: string; onPress: () => void }>;

function InlineRetry({ label, color, onPress }: InlineRetryProps) {
  return (
    <Pressable
      className="flex-row items-center gap-1 active:opacity-70"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <RefreshCw size={14} color={color} />
      <Text className="text-xs font-medium text-destructive">Retry</Text>
    </Pressable>
  );
}

type CategoryMeta = Readonly<{
  key: NotificationCategoryKey;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}>;

const CATEGORY_META: readonly CategoryMeta[] = [
  {
    key: 'chatMessages',
    title: 'Chat messages',
    subtitle: 'replies in your conversations',
    icon: MessageSquare,
  },
  {
    key: 'agentAttention',
    title: 'Agent needs you',
    subtitle: 'questions, permission, input needed',
    icon: KeyRound,
  },
  {
    key: 'agentUpdates',
    title: 'Agent updates',
    subtitle: 'mid-task messages from the agent',
    icon: Bot,
  },
  {
    key: 'sessionStatus',
    title: 'Session status',
    subtitle: 'finished / failed / ready to control',
    icon: ListTodo,
  },
  {
    key: 'kiloclawActivity',
    title: 'KiloClaw activity',
    subtitle: 'instance ready/failed, scheduled actions',
    icon: Sparkles,
  },
] as const;

type CategoryRowProps = Readonly<{
  meta: CategoryMeta;
  queryKey: readonly unknown[];
  queryClient: ReturnType<typeof useQueryClient>;
  preferences: NotificationPreferences | undefined;
  disabled: boolean;
  isPending: boolean;
  onChange: (next: boolean) => void;
}>;

function CategoryRow({
  meta,
  queryKey,
  queryClient,
  preferences,
  disabled,
  isPending,
  onChange,
}: CategoryRowProps) {
  const colors = useThemeColors();
  const Icon = meta.icon;
  // Display the optimistic value while a mutation is in flight; otherwise
  // fall back to the persisted value (or the default-ON semantics when the
  // query has not yet resolved).
  const displayedValue = isPending
    ? readAgentPushPreference(queryClient, queryKey, meta.key)
    : (preferences?.[meta.key] ?? readAgentPushPreference(queryClient, queryKey, meta.key));
  const editable = deriveAgentPushEditable({ hasData: preferences != null, isPending });
  const isDisabled = disabled || !editable;
  return (
    <View
      className={`min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3 ${isDisabled ? 'opacity-40' : ''}`}
    >
      <Icon size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        <Text className="text-sm font-medium">{meta.title}</Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {meta.subtitle}
        </Text>
      </View>
      {isPending && <ActivityIndicator size="small" color={colors.mutedForeground} />}
      <Switch
        value={displayedValue}
        disabled={isDisabled}
        accessibilityLabel={meta.title}
        accessibilityState={{ disabled: isDisabled, busy: isPending }}
        onValueChange={value => {
          if (isDisabled) {
            return;
          }
          onChange(value);
        }}
      />
    </View>
  );
}

export function NotificationsScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { token: authToken } = useAuth();
  const isAuthenticated = authToken != null;

  const [isTogglingPermission, setIsTogglingPermission] = useState(false);
  const [isRegisteringToken, setIsRegisteringToken] = useState(false);
  // Which single category is currently mid-mutation (tRPC mutation's
  // `isPending` is shared across the whole procedure, so we track the
  // in-flight category explicitly to scope the row's busy state).
  const [pendingCategory, setPendingCategory] = useState<NotificationCategoryKey | null>(null);
  // The mutation's onMutate callback reads which category we're flipping
  // from this ref (set just before mutate() is called). Using a ref keeps
  // the mutation object stable across renders.
  const pendingCategoryRef = useRef<NotificationCategoryKey | null>(null);

  const {
    data: permissionGranted = false,
    isLoading: permissionLoading,
    isError: permissionError,
    refetch: refetchPermission,
  } = useQuery({
    queryKey: permissionQueryKey,
    queryFn: async () => {
      const status = await getNotificationPermissionStatus();
      return status === 'granted';
    },
  });

  const {
    data: deviceToken,
    isError: deviceTokenError,
    refetch: refetchDeviceToken,
  } = useQuery({
    queryKey: deviceTokenQueryKey,
    queryFn: getDevicePushToken,
    enabled: permissionGranted,
  });

  const {
    data: pushTokens,
    isError: pushTokensError,
    refetch: refetchPushTokens,
  } = useQuery({
    ...trpc.user.getMyPushTokens.queryOptions(),
    enabled: isAuthenticated,
  });
  const pushTokensQueryKey = trpc.user.getMyPushTokens.queryOptions().queryKey;
  const serverRegistered =
    deviceToken != null && (pushTokens ?? []).some(t => t.token === deviceToken);

  const {
    data: preferences,
    isLoading: preferencesLoading,
    isError: preferencesError,
    refetch: refetchPreferences,
  } = useQuery({
    ...trpc.user.getNotificationPreferences.queryOptions(),
    enabled: isAuthenticated,
  });
  const preferencesQueryKey = trpc.user.getNotificationPreferences.queryOptions().queryKey;

  // Master gate: OS permission granted AND device push token registered on backend.
  const notificationsEnabled = permissionGranted && serverRegistered;
  const showEnableCta = deriveShowEnableCta(notificationsEnabled);

  // Re-check permission on foreground resume
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!wasActiveRef.current && isActive) {
      void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
    }
    wasActiveRef.current = isActive;
  }, [isActive, queryClient]);

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pushTokensQueryKey });
    void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
  }, [queryClient, pushTokensQueryKey, preferencesQueryKey]);

  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: pushTokensQueryKey });
        const previous = queryClient.getQueryData(pushTokensQueryKey);
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

  // A single shared `setNotificationPreferences` mutation reused for every
  // category. We pass ONE key per call so the server-side partial update
  // only touches the column the user is flipping; the optimistic helper
  // scopes its in-memory flip to that same key.
  const setPreference = useMutation(
    trpc.user.setNotificationPreferences.mutationOptions({
      // react-query's onMutate signature requires either an async function or
      // a plain return of a Promise; we need async semantics so the optimistic
      // write commits before the mutation body runs.
      // eslint-disable-next-line require-await, typescript-eslint/return-await
      onMutate: async variables => {
        const category = pendingCategoryRef.current;
        if (category == null) {
          return undefined;
        }
        const next = variables[category];
        if (typeof next !== 'boolean') {
          return undefined;
        }
        return applyAgentPushOptimistic({
          queryClient,
          queryKey: preferencesQueryKey,
          next,
          category,
        });
      },
      onError: (error, _vars, context) => {
        rollbackAgentPushOptimistic({
          queryClient,
          queryKey: preferencesQueryKey,
          context,
        });
        toast.error(error.message);
      },
      onSettled: () => {
        setPendingCategory(null);
        void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
      },
    })
  );

  const handleCategoryChange = useCallback(
    (category: NotificationCategoryKey, next: boolean) => {
      pendingCategoryRef.current = category;
      setPendingCategory(category);
      setPreference.mutate({ [category]: next });
    },
    [setPreference]
  );

  const handleEnableNotifications = useCallback(async () => {
    const currentStatus = await getNotificationPermissionStatus();
    if (currentStatus === 'denied') {
      Alert.alert(
        'Notifications disabled',
        'To enable notifications, turn them on in your device settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
      return;
    }
    setIsTogglingPermission(true);
    try {
      const result = await Notifications.requestPermissionsAsync();
      void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
      if (result.status === Notifications.PermissionStatus.GRANTED || result.granted) {
        setIsTogglingPermission(false);
        const token = await registerForPushNotifications();
        if (!token) {
          toast.error('Registration failed. Check your notification permissions.');
          return;
        }
        setIsRegisteringToken(true);
        try {
          await registerToken.mutateAsync({ token, platform: getPlatform() });
        } finally {
          setIsRegisteringToken(false);
        }
      }
    } catch {
      // registerToken's onError already shows the toast.
    } finally {
      setIsTogglingPermission(false);
    }
  }, [queryClient, registerToken]);

  const handleDisableNotifications = useCallback(() => {
    Alert.alert(
      'Disable notifications',
      'To disable notifications, turn them off in your device settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ]
    );
  }, []);

  const isMasterBusy = isTogglingPermission || isRegisteringToken;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Notifications" />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Master gate */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Push
          </Text>
          <View
            className={`flex-row items-center gap-3 rounded-lg bg-secondary p-3 ${!notificationsEnabled ? 'opacity-50' : ''}`}
          >
            {notificationsEnabled ? (
              <Bell size={18} color={colors.secondaryForeground} />
            ) : (
              <BellOff size={18} color={colors.secondaryForeground} />
            )}
            <View className="flex-1">
              <Text className="text-sm font-medium">Notifications enabled</Text>
              <Text variant="muted" className="mt-0.5 text-xs">
                {notificationsEnabled
                  ? 'Push notifications are on for this device.'
                  : 'Permission or device registration is off.'}
              </Text>
            </View>
            {permissionLoading && <Skeleton className="h-8 w-12 rounded-full" />}
            {!permissionLoading && permissionError && (
              <InlineRetry
                label="Retry checking notification permission"
                color={colors.destructive}
                onPress={() => void refetchPermission()}
              />
            )}
            {!permissionLoading && !permissionError && (
              <>
                {isMasterBusy && <ActivityIndicator size="small" color={colors.mutedForeground} />}
                <Switch
                  value={notificationsEnabled}
                  disabled={isMasterBusy}
                  accessibilityState={{ disabled: isMasterBusy, busy: isMasterBusy }}
                  onValueChange={value => {
                    if (value) {
                      void handleEnableNotifications();
                    } else {
                      handleDisableNotifications();
                    }
                  }}
                />
              </>
            )}
          </View>

          {/* Empty-state CTA: only shown when the master gate is closed. The
              retryable unhappy path (a category mutation rejection) is handled
              by the toggle itself — there is no terminal failure mode for
              these preferences, so a non-retryable CTA is structurally absent. */}
          {showEnableCta && !permissionLoading && !permissionError && (
            <View className="rounded-lg border border-border bg-card p-4">
              <View className="flex-row items-start gap-3">
                <CircleCheck size={18} color={colors.foreground} />
                <View className="flex-1 gap-1">
                  <Text className="text-sm font-medium">Enable notifications</Text>
                  <Text variant="muted" className="text-xs">
                    Turn on push notifications to receive category alerts on this device.
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => void handleEnableNotifications()}
                disabled={isMasterBusy}
                accessibilityRole="button"
                accessibilityLabel="Enable notifications"
                className="mt-3 items-center rounded-lg bg-primary py-2.5 active:opacity-80"
              >
                {isMasterBusy ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text className="text-sm font-semibold text-primary-foreground">
                    Enable notifications
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </View>

        {/* Categories */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Categories
          </Text>
          {preferencesLoading && (
            <>
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </>
          )}
          {preferencesError && (
            <View className="rounded-lg bg-secondary p-3">
              <InlineRetry
                label="Retry loading notification categories"
                color={colors.destructive}
                onPress={() => void refetchPreferences()}
              />
            </View>
          )}
          {preferences && (
            <>
              {CATEGORY_META.map(meta => (
                <CategoryRow
                  key={meta.key}
                  meta={meta}
                  queryKey={preferencesQueryKey}
                  queryClient={queryClient}
                  preferences={preferences}
                  disabled={!notificationsEnabled}
                  isPending={pendingCategory === meta.key}
                  onChange={next => {
                    handleCategoryChange(meta.key, next);
                  }}
                />
              ))}
            </>
          )}
        </View>

        {/* Device-token / pushTokens error retry block */}
        {(deviceTokenError || pushTokensError) && !permissionError && (
          <View className="rounded-lg bg-secondary p-3">
            <InlineRetry
              label="Retry loading device push registration"
              color={colors.destructive}
              onPress={() => {
                void refetchDeviceToken();
                void refetchPushTokens();
              }}
            />
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
