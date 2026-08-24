/* eslint-disable max-lines -- The dedicated Notifications screen composes the master
 * OS-permission gate, the push-token registration flow, and 7 per-category toggles
 * with their optimistic-mutation + retry + loading patterns. CATEGORY_META still
 * has seven keys; the KiloClaw row is hidden when useKiloClawTabVisible is false.
 * Extracting subcomponents would re-encode the same hooks. The screen stays a
 * single rendered surface. */
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Application from 'expo-application';
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
  ShieldAlert,
  Sparkles,
  Wallet,
} from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { deriveMasterGateLeadingPresentation } from '@/components/notifications-master-gate';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import {
  applyAgentPushOptimistic,
  deriveAgentPushEditable,
  deriveGateSettled,
  deriveShowEnableCta,
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategoryKey,
  type NotificationPreferences,
  readAgentPushPreference,
  rollbackAgentPushOptimistic,
} from '@/lib/hooks/agent-push-preference';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useKiloClawTabVisible } from '@/lib/hooks/use-kiloclaw-tab-visible';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

const permissionQueryKey = ['notificationPermission'] as const;
const deviceTokenQueryKey = ['devicePushToken'] as const;

/**
 * Resolve which category a `setNotificationPreferences` mutation invocation was
 * for from its `{ [category]: next }` payload. Each row sends exactly one
 * category key, so each mutation callback can scope its pending/optimistic
 * bookkeeping to its own category instead of a shared, race-prone ref.
 */
function categoryFromVariables(
  variables: Partial<Record<string, unknown>>
): NotificationCategoryKey | undefined {
  return NOTIFICATION_CATEGORY_KEYS.find(key => key in variables);
}

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
  {
    key: 'balanceAlerts',
    title: 'Balance alerts',
    subtitle: 'low organization balance warnings',
    icon: Wallet,
  },
  {
    key: 'securityFindings',
    title: 'Security findings',
    subtitle: 'new findings and SLA reminders',
    icon: ShieldAlert,
  },
] as const;

/** Per-category availability from the preferences response `capabilities` map. */
type NotificationCategoryCapability = Readonly<{
  available: boolean;
  unavailableReason: string | null;
}>;

type CategoryRowProps = Readonly<{
  meta: CategoryMeta;
  queryKey: readonly unknown[];
  queryClient: ReturnType<typeof useQueryClient>;
  preferences: NotificationPreferences | undefined;
  capability: NotificationCategoryCapability | undefined;
  disabled: boolean;
  isPending: boolean;
  onChange: (next: boolean) => void;
}>;

function CategoryRow({
  meta,
  queryKey,
  queryClient,
  preferences,
  capability,
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
  // An unavailable category is a terminal, non-retryable state: the switch is
  // disabled and the server reason replaces the subtitle. A missing entry (the
  // `noUncheckedIndexedAccess` widening) defaults to available.
  const unavailable = capability?.available === false;
  const isDisabled = disabled || !editable || unavailable;
  const subtitle = unavailable ? (capability.unavailableReason ?? meta.subtitle) : meta.subtitle;
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Icon size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        {/* Disabled cue is the muted title, not row opacity: blanket opacity
            drops every label below the 4.5:1 text minimum. The Switch renders
            its own disabled appearance. */}
        <Text className={cn('text-sm font-medium', isDisabled && 'text-muted-foreground')}>
          {meta.title}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
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
  const showKiloClawActivity = useKiloClawTabVisible();
  const { token: authToken } = useAuth();
  const isAuthenticated = authToken != null;

  const [isTogglingPermission, setIsTogglingPermission] = useState(false);
  const [isRegisteringToken, setIsRegisteringToken] = useState(false);
  // The `setNotificationPreferences` mutation object is shared across all five
  // rows, and its `isPending` is a single flag for the whole procedure. Two
  // category flips can therefore be in flight at once, so we track the set of
  // in-flight categories explicitly and scope each row's busy state to its own
  // key. Each mutation callback resolves its own category from `variables`
  // (the single `{ [category]: next }` payload) rather than a shared ref, so a
  // later flip can never clear an earlier flip's pending/optimistic state.
  const [pendingCategories, setPendingCategories] = useState<ReadonlySet<NotificationCategoryKey>>(
    () => new Set()
  );

  // The preview row is a single string-enum control (not a boolean category),
  // so its in-flight, error, and last-intent state is tracked separately from
  // `pendingCategories`. `previewIntent` remembers the value the user last
  // tried to set so the inline retry can re-attempt it.
  const [isPreviewPending, setIsPreviewPending] = useState(false);
  const [previewErrorCode, setPreviewErrorCode] = useState<string | undefined>(undefined);
  const [previewIntent, setPreviewIntent] = useState<'generic' | 'full'>('generic');

  const {
    data: permissionGranted = false,
    isLoading: permissionLoading,
    isError: permissionError,
    isFetched: permissionFetched,
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
    isFetched: deviceTokenFetched,
    refetch: refetchDeviceToken,
  } = useQuery({
    queryKey: deviceTokenQueryKey,
    queryFn: getDevicePushToken,
    enabled: permissionGranted,
  });

  const {
    data: pushTokens,
    isError: pushTokensError,
    isFetched: pushTokensFetched,
    refetch: refetchPushTokens,
  } = useQuery({
    ...trpc.user.getMyPushTokens.queryOptions(),
    enabled: isAuthenticated,
  });
  const pushTokensQueryKey = trpc.user.getMyPushTokens.queryOptions().queryKey;
  const serverRegistered =
    deviceToken != null && (pushTokens ?? []).some(t => t.token === deviceToken);

  // Each *Settled is isFetched || isError for the enabled query. Do not invent
  // a "disabled → settled" mapping for deviceToken — deriveGateSettled
  // short-circuits when permission is denied so disabled flags are never read.
  const gateSettled = deriveGateSettled({
    permissionSettled: permissionFetched || permissionError,
    permissionGranted,
    pushTokensSettled: pushTokensFetched || pushTokensError,
    deviceTokenSettled: deviceTokenFetched || deviceTokenError,
  });

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

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  const registerToken = useMutation(
    trpc.user.registerPushToken.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: pushTokensQueryKey });
        const generation = nextMutationGeneration(hashKey(pushTokensQueryKey));
        const previous = queryClient.getQueryData(pushTokensQueryKey);
        if (deviceToken) {
          queryClient.setQueryData(pushTokensQueryKey, (old: typeof pushTokens) => [
            ...(old ?? []),
            { token: deviceToken, platform: getPlatform() },
          ]);
        }
        return { previous, generation };
      },
      onError: (error, _vars, context) => {
        if (
          context?.previous &&
          isLatestMutationGeneration(hashKey(pushTokensQueryKey), context.generation)
        ) {
          queryClient.setQueryData(pushTokensQueryKey, context.previous);
        }
        toast.error(error.message);
      },
      onSettled: invalidateAll,
      // One fixed cache entry, so a single static scope id serializes the
      // network call (rule 2).
      scope: { id: 'push-tokens' },
    })
  );

  // A single shared `setNotificationPreferences` mutation reused for every
  // category. We pass ONE key per call so the server-side partial update
  // only touches the column the user is flipping; the optimistic helper
  // scopes its in-memory flip to that same key.
  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  const setPreference = useMutation(
    trpc.user.setNotificationPreferences.mutationOptions({
      // async so the optimistic write commits before the mutation body runs.
      onMutate: async variables => {
        const category = categoryFromVariables(variables);
        if (category == null) {
          return undefined;
        }
        const next = variables[category];
        if (next === undefined) {
          return undefined;
        }
        // The helper stamps its own generation after its `cancelQueries`
        // await, so the stamp cannot drift from the cache write it guards.
        const context = await applyAgentPushOptimistic({
          queryClient,
          queryKey: preferencesQueryKey,
          next,
          category,
        });
        return context;
      },
      onError: (error, variables, context) => {
        if (
          context &&
          isLatestMutationGeneration(hashKey(preferencesQueryKey), context.generation)
        ) {
          rollbackAgentPushOptimistic({
            queryClient,
            queryKey: preferencesQueryKey,
            context,
          });
        }
        toast.error(error.message);
        if (variables.notificationPreviews !== undefined) {
          setPreviewErrorCode(readTrpcErrorField(error, 'code'));
        }
      },
      onSettled: (_data, _error, variables) => {
        const category = categoryFromVariables(variables);
        if (category != null) {
          setPendingCategories(prev => {
            if (!prev.has(category)) {
              return prev;
            }
            const next = new Set(prev);
            next.delete(category);
            return next;
          });
        }
        if (variables.notificationPreviews !== undefined) {
          setIsPreviewPending(false);
        }
        void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
      },
      // One fixed cache entry, so a single static scope id serializes the
      // network call (rule 2).
      scope: { id: 'notification-preferences' },
    })
  );

  const handleCategoryChange = useCallback(
    (category: NotificationCategoryKey, next: boolean) => {
      setPendingCategories(prev => new Set([...prev, category]));
      setPreference.mutate({ [category]: next });
    },
    [setPreference]
  );

  const handlePreviewChange = useCallback(
    (next: 'generic' | 'full') => {
      setPreviewErrorCode(undefined);
      setPreviewIntent(next);
      setIsPreviewPending(true);
      setPreference.mutate({ notificationPreviews: next });
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
        // Keep `isTogglingPermission` set through token registration so the
        // master switch stays busy for the whole enable flow. Clearing it here
        // (before `isRegisteringToken` is set) would briefly re-enable the
        // switch mid-flow and allow a re-entrant enable/disable.
        const token = await registerForPushNotifications();
        if (!token) {
          toast.error('Registration failed. Check your notification permissions.');
          return;
        }
        setIsRegisteringToken(true);
        try {
          await registerToken.mutateAsync({
            token,
            platform: getPlatform(),
            appVersion: Application.nativeApplicationVersion ?? undefined,
          });
        } catch {
          // registerToken's onError already surfaced the toast; swallow here so
          // the outer catch does not double-report the same failure.
        } finally {
          setIsRegisteringToken(false);
        }
      }
    } catch {
      // A failure here comes from requestPermissionsAsync or
      // registerForPushNotifications (the registration mutation reports its own
      // error above), so surface the feedback the previous card also showed.
      toast.error('Could not enable notifications. Please try again.');
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
  const masterLeading = deriveMasterGateLeadingPresentation({
    permissionLoading,
    permissionError,
    gateSettled,
    notificationsEnabled,
  });

  // Message-preview row: a single string-enum control rendered from the server
  // value with no optimistic flip. UNAUTHORIZED is a terminal failure (the row
  // stays disabled with no retry); any other mutation error is retryable.
  const previewValue = preferences?.notificationPreviews ?? 'generic';
  const previewIsFull = previewValue === 'full';
  const previewTerminal = previewErrorCode === 'UNAUTHORIZED';
  const previewDisabled = !notificationsEnabled || isPreviewPending || previewTerminal;

  // Old form: CATEGORY_META always rendered kiloclawActivity. Keep the key in
  // CATEGORY_META and in notification preferences. Hide the row when the user
  // has no active instance. Remove this filter only when product deletes the
  // kiloclawActivity preference.
  const visibleCategoryMeta = CATEGORY_META.filter(
    meta => meta.key !== 'kiloclawActivity' || showKiloClawActivity
  );

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
          <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
            {masterLeading === 'neutral' && <Skeleton className="h-[18px] w-[18px] rounded" />}
            {masterLeading === 'on' && <Bell size={18} color={colors.secondaryForeground} />}
            {masterLeading === 'off' && <BellOff size={18} color={colors.secondaryForeground} />}
            <View className="flex-1">
              <Text className="text-sm font-medium">Notifications enabled</Text>
              {masterLeading === 'neutral' && <Skeleton className="mt-0.5 h-4 w-52" />}
              {masterLeading === 'on' && (
                <Text variant="muted" className="mt-0.5 text-xs">
                  Push notifications are on for this device.
                </Text>
              )}
              {masterLeading === 'off' && (
                <Text variant="muted" className="mt-0.5 text-xs">
                  Permission or device registration is off.
                </Text>
              )}
            </View>
            {/* Master trailing slot — first match wins:
                1. permissionLoading → skeleton
                2. permissionError → InlineRetry
                3. !gateSettled → skeleton (token queries still settling)
                4. else → real Switch (+ optional isMasterBusy spinner) */}
            {permissionLoading && <Skeleton className="h-[31px] w-[51px] rounded-full" />}
            {!permissionLoading && permissionError && (
              <InlineRetry
                label="Retry checking notification permission"
                color={colors.destructive}
                onPress={() => void refetchPermission()}
              />
            )}
            {!permissionLoading && !permissionError && !gateSettled && (
              <Skeleton className="h-[31px] w-[51px] rounded-full" />
            )}
            {!permissionLoading && !permissionError && gateSettled && (
              <>
                {isMasterBusy && <ActivityIndicator size="small" color={colors.mutedForeground} />}
                <Switch
                  value={notificationsEnabled}
                  disabled={isMasterBusy}
                  accessibilityLabel="Notifications enabled"
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

          {/* Empty-state CTA: only shown when the master gate is closed and the
              gate has settled (avoids a transient flash while token queries
              resolve for an already-registered user). The retryable unhappy
              path (a category mutation rejection) is handled by the toggle
              itself — there is no terminal failure mode for these preferences,
              so a non-retryable CTA is structurally absent. */}
          {!permissionLoading && !permissionError && gateSettled && showEnableCta && (
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
              {visibleCategoryMeta.map(meta => (
                <View
                  key={meta.key}
                  className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3"
                >
                  <Skeleton className="h-[18px] w-[18px] rounded" />
                  <View className="flex-1">
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="mt-0.5 h-4 w-40" />
                  </View>
                  <Skeleton className="h-[31px] w-[51px] rounded-full" />
                </View>
              ))}
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
              {visibleCategoryMeta.map(meta => (
                <CategoryRow
                  key={meta.key}
                  meta={meta}
                  queryKey={preferencesQueryKey}
                  queryClient={queryClient}
                  preferences={preferences}
                  capability={
                    // The server type marks `capabilities` required, but a
                    // backend that predates the field returns none. The guard
                    // keeps the old response on the always-available path.
                    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
                    preferences.capabilities?.[meta.key] ?? {
                      available: true,
                      unavailableReason: null,
                    }
                  }
                  disabled={!notificationsEnabled}
                  isPending={pendingCategories.has(meta.key)}
                  onChange={next => {
                    handleCategoryChange(meta.key, next);
                  }}
                />
              ))}
            </>
          )}
        </View>

        {/* Message previews */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Message previews
          </Text>
          {preferencesLoading && (
            <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
              <View className="flex-1">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="mt-0.5 h-4 w-40" />
              </View>
              <Skeleton className="h-[31px] w-[51px] rounded-full" />
            </View>
          )}
          {preferencesError && (
            <View className="rounded-lg bg-secondary p-3">
              <InlineRetry
                label="Retry loading notification previews"
                color={colors.destructive}
                onPress={() => void refetchPreferences()}
              />
            </View>
          )}
          {preferences && (
            <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
              <View className="flex-1">
                <Text
                  className={cn('text-sm font-medium', previewDisabled && 'text-muted-foreground')}
                >
                  {previewIsFull ? 'Always' : 'When unlocked'}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {previewIsFull
                    ? 'Notifications show the message text on your lock screen.'
                    : 'Notifications show that something happened. Open Kilo to read it.'}
                </Text>
              </View>
              {isPreviewPending && (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              )}
              {previewErrorCode !== undefined && !previewTerminal && (
                <InlineRetry
                  label="Retry saving notification previews"
                  color={colors.destructive}
                  onPress={() => {
                    handlePreviewChange(previewIntent);
                  }}
                />
              )}
              <Switch
                value={previewIsFull}
                disabled={previewDisabled}
                accessibilityLabel="Show full previews"
                accessibilityState={{ disabled: previewDisabled, busy: isPreviewPending }}
                onValueChange={value => {
                  if (previewDisabled) {
                    return;
                  }
                  handlePreviewChange(value ? 'full' : 'generic');
                }}
              />
            </View>
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
