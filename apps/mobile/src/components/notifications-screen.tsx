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
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wallet,
} from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
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
  const { t } = useTranslation();
  return (
    <Pressable
      className="flex-row items-center gap-1 active:opacity-70"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <RefreshCw size={14} color={color} />
      <Text className="text-xs font-medium text-destructive">{t('common.retry')}</Text>
    </Pressable>
  );
}

const CATEGORY_META = [
  {
    key: 'chatMessages',
    titleKey: 'notifications.category.chatMessagesTitle',
    subtitleKey: 'notifications.category.chatMessagesSubtitle',
    icon: MessageSquare,
  },
  {
    key: 'agentAttention',
    titleKey: 'notifications.category.agentAttentionTitle',
    subtitleKey: 'notifications.category.agentAttentionSubtitle',
    icon: KeyRound,
  },
  {
    key: 'agentUpdates',
    titleKey: 'notifications.category.agentUpdatesTitle',
    subtitleKey: 'notifications.category.agentUpdatesSubtitle',
    icon: Bot,
  },
  {
    key: 'sessionStatus',
    titleKey: 'notifications.category.sessionStatusTitle',
    subtitleKey: 'notifications.category.sessionStatusSubtitle',
    icon: ListTodo,
  },
  {
    key: 'kiloclawActivity',
    titleKey: 'notifications.category.kiloclawActivityTitle',
    subtitleKey: 'notifications.category.kiloclawActivitySubtitle',
    icon: Sparkles,
  },
  {
    key: 'balanceAlerts',
    titleKey: 'notifications.category.balanceAlertsTitle',
    subtitleKey: 'notifications.category.balanceAlertsSubtitle',
    icon: Wallet,
  },
  {
    key: 'securityFindings',
    titleKey: 'notifications.category.securityFindingsTitle',
    subtitleKey: 'notifications.category.securityFindingsSubtitle',
    icon: ShieldAlert,
  },
] as const;

type CategoryMeta = (typeof CATEGORY_META)[number];

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
  const { t } = useTranslation();
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
  const title = t(meta.titleKey);
  const subtitle = unavailable
    ? (capability.unavailableReason ?? t(meta.subtitleKey))
    : t(meta.subtitleKey);
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Icon size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        {/* Disabled cue is the muted title, not row opacity: blanket opacity
            drops every label below the 4.5:1 text minimum. The Switch renders
            its own disabled appearance. */}
        <Text className={cn('text-sm font-medium', isDisabled && 'text-muted-foreground')}>
          {title}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
        </Text>
      </View>
      {isPending && <ActivityIndicator size="small" color={colors.mutedForeground} />}
      <Switch
        value={displayedValue}
        disabled={isDisabled}
        accessibilityLabel={title}
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
  const { t } = useTranslation();
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
    deviceToken != null && (pushTokens ?? []).some(pushToken => pushToken.token === deviceToken);

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
            { token: deviceToken, platform: getPlatform(), locale: getResolvedLanguage() },
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
      Alert.alert(t('notifications.disabledTitle'), t('notifications.disabledMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('notifications.openSettings'), onPress: () => void Linking.openSettings() },
      ]);
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
          toast.error(t('notifications.registrationFailed'));
          return;
        }
        setIsRegisteringToken(true);
        try {
          await registerToken.mutateAsync({
            token,
            platform: getPlatform(),
            appVersion: Application.nativeApplicationVersion ?? undefined,
            // Without this the row is written with a null locale, so every push
            // to a device enrolled from this screen arrives in English.
            locale: getResolvedLanguage(),
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
      toast.error(t('notifications.couldNotEnable'));
    } finally {
      setIsTogglingPermission(false);
    }
  }, [queryClient, registerToken, t]);

  const handleDisableNotifications = useCallback(() => {
    Alert.alert(t('notifications.disableTitle'), t('notifications.disableMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('notifications.openSettings'), onPress: () => void Linking.openSettings() },
    ]);
  }, [t]);

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
      <ScreenHeader title={t('notifications.title')} />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Master gate */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('notifications.push')}
          </Text>
          <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
            {masterLeading === 'neutral' && <Skeleton className="h-[18px] w-[18px] rounded" />}
            {masterLeading === 'on' && <Bell size={18} color={colors.secondaryForeground} />}
            {masterLeading === 'off' && <BellOff size={18} color={colors.secondaryForeground} />}
            <View className="flex-1">
              <Text className="text-sm font-medium">{t('notifications.enabled')}</Text>
              {masterLeading === 'neutral' && <Skeleton className="mt-0.5 h-4 w-52" />}
              {masterLeading === 'on' && (
                <Text variant="muted" className="mt-0.5 text-xs">
                  {t('notifications.onDescription')}
                </Text>
              )}
              {masterLeading === 'off' && (
                <Text variant="muted" className="mt-0.5 text-xs">
                  {t('notifications.offDescription')}
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
                label={t('notifications.retryPermission')}
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
                  accessibilityLabel={t('notifications.enabled')}
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
                  <Text className="text-sm font-medium">{t('notifications.enable')}</Text>
                  <Text variant="muted" className="text-xs">
                    {t('notifications.enableDescription')}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => void handleEnableNotifications()}
                disabled={isMasterBusy}
                accessibilityRole="button"
                accessibilityLabel={t('notifications.enable')}
                className="mt-3 items-center rounded-lg bg-primary py-2.5 active:opacity-80"
              >
                {isMasterBusy ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text className="text-sm font-semibold text-primary-foreground">
                    {t('notifications.enable')}
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </View>

        {/* Categories */}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('notifications.categories')}
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
                label={t('notifications.retryCategories')}
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
            {t('notifications.messagePreviews')}
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
                label={t('notifications.retryPreviews')}
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
                  {previewIsFull
                    ? t('notifications.previewAlways')
                    : t('notifications.previewWhenUnlocked')}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {previewIsFull
                    ? t('notifications.previewFullDescription')
                    : t('notifications.previewGenericDescription')}
                </Text>
              </View>
              {isPreviewPending && (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              )}
              {previewErrorCode !== undefined && !previewTerminal && (
                <InlineRetry
                  label={t('notifications.retrySavingPreviews')}
                  color={colors.destructive}
                  onPress={() => {
                    handlePreviewChange(previewIntent);
                  }}
                />
              )}
              <Switch
                value={previewIsFull}
                disabled={previewDisabled}
                accessibilityLabel={t('notifications.showFullPreviews')}
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
              label={t('notifications.retryDeviceRegistration')}
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
