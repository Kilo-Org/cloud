/* eslint-disable max-lines -- notification settings keep OS permission, registration, and preference mutations together. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import {
  Bell,
  BellOff,
  Bot,
  KeyRound,
  ListTodo,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Wallet,
} from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Linking, Platform, Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';

import { deriveMasterGateLeadingPresentation } from '@/components/notifications-master-gate';
import { BriefingNotificationCategoryRow } from '@/components/agent-briefing/briefing-notification-toggle';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { liveActivitiesAllowedBySystem } from '@/glanceable-ios/system-switch';
import { createSubmitLock } from '@/lib/submit-lock';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
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
import { useLiveActivityPreference } from '@/lib/hooks/use-live-activity-preference';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  emitNotificationPermissionResponded,
  emitNotificationTokenUpdated,
  getDevicePushToken,
  getNotificationPermissionStatus,
  getPlatform,
  registerForPushNotifications,
} from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

const permissionQueryKey = ['notificationPermission'] as const;

/**
 * The glanceable row's subtitle: what it promises while the OS allows it, and
 * what to do about it when the OS does not. Each platform names its own surface
 * and its own setting.
 */
function glanceableSubtitleKey(allowed: boolean, isIos: boolean): string {
  if (!allowed) {
    return isIos ? 'glanceable.activityKitDisabledBody' : 'notifications.disabledMessage';
  }
  return isIos ? 'notifications.liveActivitySubtitle' : 'notifications.liveUpdateSubtitle';
}
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
      className={cn(STATE_ACTION_CLASS, 'flex-row items-center gap-1 active:opacity-70')}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <RefreshCw size={14} color={color} />
      <Text className="text-xs font-medium text-destructive">{t('common.retry')}</Text>
    </Pressable>
  );
}

/** One row per notification category. */
const CATEGORY_META = [
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
    key: 'balanceAlerts',
    titleKey: 'notifications.channel.balance',
    subtitleKey: 'notifications.category.balanceAlertsSubtitle',
    icon: Wallet,
  },
  {
    key: 'spendAlerts',
    titleKey: 'notifications.channel.spend',
    subtitleKey: 'notifications.category.spendAlertsSubtitle',
    icon: Wallet,
    // A dedicated label for the device scene: the spend view owns a switch with
    // the same visible wording, so this row's control must be addressable on
    // its own. The low-balance sheet uses the same `*A11y` pattern.
    accessibilityLabelKey: 'notifications.category.spendAlertsToggle',
  },
  {
    key: 'securityFindings',
    titleKey: 'notifications.channel.security',
    subtitleKey: 'notifications.category.securityFindingsSubtitle',
    icon: ShieldAlert,
  },
] as const;

/**
 * The reason each gated category shows while the server marks it unavailable.
 * The response's old `unavailableReason` was an English sentence, so the row
 * renders mobile copy instead: the reason must read in the user's language.
 * Of the categories mobile renders, only balance alerts and security findings
 * carry a gate in the server's capability map
 * (`apps/web/src/routers/user-router.ts: computeNotificationCapabilities`); the
 * other four are always available there.
 *
 * This is the fallback for a response that carries no reason code at all — a
 * server predating the code sent the very sentence this copy translates — so
 * such a row keeps the same meaning in the reader's language.
 */
const CATEGORY_UNAVAILABLE_SUBTITLE_KEYS: ReadonlyMap<NotificationCategoryKey, string> = new Map([
  ['balanceAlerts', 'notifications.category.balanceAlertsUnavailable'],
  ['securityFindings', 'notifications.category.securityFindingsUnavailable'],
]);

type CategoryMeta = (typeof CATEGORY_META)[number];

/** Per-category availability from the preferences response `capabilities` map. */
type NotificationPreferencesResponse =
  inferRouterOutputs<MobileRouter>['user']['getNotificationPreferences'];
type NotificationCategoryCapability =
  NotificationPreferencesResponse['capabilities'][NotificationCategoryKey];
type UnavailableReasonCode = NonNullable<NotificationCategoryCapability['unavailableReasonCode']>;

/**
 * The server sends a machine-readable reason code, never a sentence: each code
 * maps to a catalog key so the row reads in the reader's language. Literal
 * values, never a template, so the catalog check can see the keys.
 */
const UNAVAILABLE_REASON_KEY = {
  organizationRequired: 'notifications.category.balanceAlertsUnavailable',
  securityAgentRequired: 'notifications.category.securityFindingsUnavailable',
} satisfies Partial<Record<UnavailableReasonCode, string>>;

/** A code from a newer server must fall back, never render raw. */
function unavailableReasonKey(code: string | null | undefined): string | undefined {
  // Object.hasOwn (not `in`) so an inherited member like 'constructor' falls
  // back to the subtitle instead of handing a prototype member to `t()`.
  if (code == null || !Object.hasOwn(UNAVAILABLE_REASON_KEY, code)) {
    return undefined;
  }
  return UNAVAILABLE_REASON_KEY[code as keyof typeof UNAVAILABLE_REASON_KEY];
}

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
  // disabled and the row explains itself in the reader's language. The server's
  // old `unavailableReason` sentence is English prose and must never render — it
  // cannot be translated — so the reason comes from the code map, or from
  // `CATEGORY_UNAVAILABLE_SUBTITLE_KEYS` when the response carries no code. A
  // missing entry (the `noUncheckedIndexedAccess` widening) defaults to
  // available.
  const unavailable = capability?.available === false;
  const unavailableReasonCode = capability?.unavailableReasonCode;
  const isDisabled = disabled || !editable || unavailable;
  const title = t(meta.titleKey);
  // The server names the reason with a code, never a sentence: a known code
  // resolves to catalog copy, and an unknown one falls back to the category's
  // own localized subtitle.
  const reasonKey = unavailable ? unavailableReasonKey(unavailableReasonCode) : undefined;
  // A response with no code at all comes from a server that predates the code
  // contract, which sent the sentence the category's catalog reason translates:
  // the row keeps that meaning in the reader's language.
  const noCodeFallbackKey =
    unavailable && unavailableReasonCode == null
      ? (CATEGORY_UNAVAILABLE_SUBTITLE_KEYS.get(meta.key) ?? meta.subtitleKey)
      : meta.subtitleKey;
  const subtitle = t(reasonKey ?? noCodeFallbackKey);
  // Most rows take the visible title as their control label; the spend row
  // carries its own so the device scene can address it unambiguously.
  const accessibilityLabel =
    'accessibilityLabelKey' in meta ? t(meta.accessibilityLabelKey) : t(meta.titleKey);
  return (
    <ConfigureRow
      icon={Icon}
      title={title}
      subtitle={subtitle}
      variant="action"
      disabled={isDisabled}
      trailing={
        <View className="flex-row items-center gap-2">
          {isPending && <ActivityIndicator size="small" color={colors.mutedForeground} />}
          <Switch
            value={displayedValue}
            disabled={isDisabled}
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled: isDisabled, busy: isPending }}
            onValueChange={value => {
              if (isDisabled) {
                return;
              }
              onChange(value);
            }}
          />
        </View>
      }
    />
  );
}

/**
 * The master push gate's enable flow: one step at a time, so no second tap can
 * start the OS permission request or the token registration the first one owns.
 */
type EnablePhase = 'requesting-permission' | 'registering-token' | null;

export function NotificationsScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { token: authToken } = useAuth();
  const isAuthenticated = authToken != null;

  const [enablePhase, setEnablePhase] = useState<EnablePhase>(null);
  // The permission read is a native round trip, and the busy flag renders only
  // after it: a second tap in that window would request the permission and
  // register the token twice. Only a synchronous lock closes it.
  const enableLock = useRef(createSubmitLock());
  // The `setNotificationPreferences` mutation object is shared across every
  // category row, and its `isPending` is a single flag for the whole procedure. Two
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

  const {
    liveActivityEnabled,
    hasLoaded: liveActivityLoaded,
    setLiveActivityEnabled,
  } = useLiveActivityPreference();
  // ActivityKit's own switch. Read on mount and again on every foreground,
  // because the only way to change it is to leave for Settings and come back.
  const [systemAllowsLiveActivities, setSystemAllowsLiveActivities] = useState(
    liveActivitiesAllowedBySystem
  );
  const isIos = Platform.OS === 'ios';
  // The OS switch that governs the glanceable surface: ActivityKit's own on
  // iOS, the notification permission on Android, which is what a Live Update
  // posts through.
  const systemAllowsGlanceable = isIos ? systemAllowsLiveActivities : permissionGranted;
  // Off in Settings, or a state the screen has not read yet: either way the
  // switch must not accept a change it cannot honor.
  const liveActivityRowDisabled =
    !liveActivityLoaded || !systemAllowsGlanceable || (!isIos && permissionLoading);

  // Re-check permission on foreground resume
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!wasActiveRef.current && isActive) {
      void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
      setSystemAllowsLiveActivities(liveActivitiesAllowedBySystem());
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
            {
              token: deviceToken,
              platform: getPlatform(),
              locale: getResolvedLanguage(),
              appVersion: Application.nativeApplicationVersion ?? null,
            },
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
    const lock = enableLock.current;
    if (!lock.acquire()) {
      return;
    }
    setEnablePhase('requesting-permission');
    try {
      const currentStatus = await getNotificationPermissionStatus();
      if (currentStatus === 'denied') {
        Alert.alert(
          t('notifications.disabledTitle'),
          t('notifications.disabledMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.openSettings'), onPress: () => void Linking.openSettings() },
          ],
          // Android back dismisses, which equals the no-op Cancel.
          { cancelable: true }
        );
        return;
      }
      const result = await Notifications.requestPermissionsAsync();
      const granted = result.status === Notifications.PermissionStatus.GRANTED || result.granted;
      // Only a live permission request emits an outcome. A pre-granted status
      // returns without prompting, so emitting here would report a spurious
      // `notification_permission_responded: granted`. This matches the
      // invariant `registerForPushNotifications` enforces for its own request.
      if (currentStatus !== 'granted') {
        emitNotificationPermissionResponded(granted);
      }
      void queryClient.invalidateQueries({ queryKey: permissionQueryKey });
      if (!granted) {
        return;
      }
      const token = await registerForPushNotifications();
      if (!token) {
        toast.error(t('notifications.registrationFailed'));
        return;
      }
      // The switch stays busy through token registration: the phase never leaves
      // `requesting-permission` while the token is being written.
      setEnablePhase('registering-token');
      try {
        await registerToken.mutateAsync({
          token,
          platform: getPlatform(),
          appVersion: Application.nativeApplicationVersion ?? undefined,
          // Without this the row is written with a null locale, so every push
          // to a device enrolled from this screen arrives in English.
          locale: getResolvedLanguage(),
        });
        emitNotificationTokenUpdated('registered');
      } catch {
        // registerToken's onError already surfaced the toast; swallow here so
        // the outer catch does not double-report the same failure.
      }
    } catch {
      // A failure here comes from requestPermissionsAsync or
      // registerForPushNotifications (the registration mutation reports its own
      // error above), so surface the feedback the previous card also showed.
      toast.error(t('notifications.couldNotEnable'));
    } finally {
      setEnablePhase(null);
      lock.release();
    }
  }, [queryClient, registerToken, t]);

  const handleDisableNotifications = useCallback(() => {
    Alert.alert(
      t('notifications.disableTitle'),
      t('notifications.disableMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.openSettings'), onPress: () => void Linking.openSettings() },
      ],
      // Android back dismisses, which equals the no-op Cancel.
      { cancelable: true }
    );
  }, [t]);

  const isMasterBusy = enablePhase !== null;
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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.notifications')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {/* The glanceable surface. First on the screen because it is what the
            user sees without opening the app, and it must not sit below eight
            category rows. Each platform names it the way its own OS does:
            a Live Activity on iOS, a Live Update on Android. */}
        <Section label={isIos ? t('notifications.liveActivities') : t('notifications.liveUpdates')}>
          <RowGroup>
            <PreferenceRow
              icon={Smartphone}
              title={t('glanceable.channelName')}
              subtitle={t(glanceableSubtitleKey(systemAllowsGlanceable, isIos))}
              value={systemAllowsGlanceable && liveActivityEnabled}
              disabled={liveActivityRowDisabled}
              onValueChange={setLiveActivityEnabled}
            />
          </RowGroup>
          {/* Our switch cannot turn ActivityKit's back on, so the row offers
              the only thing that can instead of pretending otherwise. Android
              needs no button here: the master gate below already enables the
              same permission. */}
          {isIos && !systemAllowsLiveActivities && (
            <Button
              variant="outline"
              className="w-full"
              accessibilityLabel={t('common.openSettings')}
              onPress={() => void Linking.openSettings()}
            >
              <Text>{t('common.openSettings')}</Text>
            </Button>
          )}
        </Section>

        {/* Master gate */}
        <Section label={t('notifications.push')}>
          <RowGroup>
            <ConfigureRow
              // The leading tile keeps its 30 dp frame in all three states, so
              // the title never moves when the permission settles into "on" or
              // "off".
              icon={masterLeading === 'on' ? Bell : BellOff}
              title={t('notifications.deviceTitle')}
              subtitle={
                masterLeading === 'on'
                  ? t('notifications.onDescription')
                  : masterLeading === 'off'
                    ? t('notifications.offDescription')
                    : undefined
              }
              subtitlePlaceholder={
                masterLeading === 'neutral' ? <Skeleton className="mt-0.5 h-4 w-52" /> : undefined
              }
              variant="action"
              // Master trailing slot — first match wins:
              // 1. permissionLoading → skeleton
              // 2. permissionError → InlineRetry
              // 3. !gateSettled → skeleton (token queries still settling)
              // 4. else → real Switch (+ optional isMasterBusy spinner)
              trailing={
                permissionLoading ? (
                  <Skeleton className="h-8 w-14 rounded-full" />
                ) : permissionError ? (
                  <InlineRetry
                    label={t('notifications.retryPermission')}
                    color={colors.destructive}
                    onPress={() => void refetchPermission()}
                  />
                ) : !gateSettled ? (
                  <Skeleton className="h-8 w-14 rounded-full" />
                ) : (
                  <View className="flex-row items-center gap-2">
                    {isMasterBusy && (
                      <ActivityIndicator size="small" color={colors.mutedForeground} />
                    )}
                    <Switch
                      value={notificationsEnabled}
                      disabled={isMasterBusy}
                      accessibilityLabel={t('notifications.deviceTitle')}
                      accessibilityState={{ disabled: isMasterBusy, busy: isMasterBusy }}
                      onValueChange={value => {
                        if (value) {
                          void handleEnableNotifications();
                        } else {
                          handleDisableNotifications();
                        }
                      }}
                    />
                  </View>
                )
              }
            />
          </RowGroup>

          {/* Empty-state CTA: only shown when the master gate is closed and the
              gate has settled (avoids a transient flash while token queries
              resolve for an already-registered user). The retryable unhappy
              path (a category mutation rejection) is handled by the toggle
              itself — there is no terminal failure mode for these preferences,
              so a non-retryable CTA is structurally absent. */}
          {!permissionLoading && !permissionError && gateSettled && showEnableCta && (
            <Card>
              <Text variant="caption">{t('notifications.enableDescription')}</Text>
              <Button
                className="w-full"
                loading={isMasterBusy}
                accessibilityLabel={t('notifications.enable')}
                onPress={() => void handleEnableNotifications()}
              >
                <Text>{t('notifications.enable')}</Text>
              </Button>
            </Card>
          )}
        </Section>

        {/* Everything below waits for the master gate. The gate's settled
            height is only known once it settles: the Push row grows by its
            description line and the Enable card mounts when push is off, which
            is about 111 dp of content that would otherwise arrive after the
            reader has already seen the sections below it (design gate
            `layout-shift` on this screen). Holding them for the gate keeps the
            first frame that can rest identical to the final one. */}
        {gateSettled && (
          <>
            {/* Categories */}
            <Section label={t('notifications.categories')}>
              {preferencesLoading && (
                <RowGroup leadingTile>
                  {CATEGORY_META.map(meta => (
                    <RowSkeleton key={meta.key} tile subtitle />
                  ))}
                </RowGroup>
              )}
              {preferencesError && (
                <Card>
                  <InlineRetry
                    label={t('notifications.retryCategories')}
                    color={colors.destructive}
                    onPress={() => void refetchPreferences()}
                  />
                </Card>
              )}
              {preferences ? (
                <RowGroup leadingTile>
                  {CATEGORY_META.map(meta => (
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
                          unavailableReasonCode: null,
                        }
                      }
                      disabled={!notificationsEnabled}
                      isPending={pendingCategories.has(meta.key)}
                      onChange={next => {
                        handleCategoryChange(meta.key, next);
                      }}
                    />
                  ))}
                  <BriefingNotificationCategoryRow disabled={!notificationsEnabled} />
                </RowGroup>
              ) : (
                <BriefingNotificationCategoryRow disabled={!notificationsEnabled} />
              )}
            </Section>

            {/* Message previews */}
            <Section label={t('notifications.messagePreviews')}>
              {preferencesLoading && (
                <RowGroup leadingTile>
                  <RowSkeleton tile subtitle />
                </RowGroup>
              )}
              {preferencesError && (
                <Card>
                  <InlineRetry
                    label={t('notifications.retryPreviews')}
                    color={colors.destructive}
                    onPress={() => void refetchPreferences()}
                  />
                </Card>
              )}
              {preferences && (
                <RowGroup>
                  <ConfigureRow
                    icon={MessageSquare}
                    title={
                      previewIsFull
                        ? t('notifications.previewAlways')
                        : t('notifications.previewWhenUnlocked')
                    }
                    subtitle={
                      previewIsFull
                        ? t('notifications.previewFullDescription')
                        : t('notifications.previewGenericDescription')
                    }
                    variant="action"
                    disabled={previewDisabled}
                    trailing={
                      <View className="flex-row items-center gap-2">
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
                    }
                  />
                </RowGroup>
              )}
            </Section>

            {/* Device-token / pushTokens error retry block */}
            {(deviceTokenError || pushTokensError) && !permissionError && (
              <Card>
                <InlineRetry
                  label={t('notifications.retryDeviceRegistration')}
                  color={colors.destructive}
                  onPress={() => {
                    void refetchDeviceToken();
                    void refetchPushTokens();
                  }}
                />
              </Card>
            )}
          </>
        )}
      </TabScreenScrollView>
    </View>
  );
}
