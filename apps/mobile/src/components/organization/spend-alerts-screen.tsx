/* eslint-disable max-lines -- The spend view composes the scope boundary, the four
load states, and two rule cards with their channel rows in one surface; splitting
the pieces would re-encode the same draft state across files. */

import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Switch, View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import {
  DEFAULT_MULTIPLIER,
  DISABLED_MULTIPLIER,
  DISABLED_THRESHOLD_USD,
  multiplierBasisPoints,
  multiplierError,
  parseMultiplier,
  parseThreshold,
  thresholdError,
  toWindowHours,
} from '@/components/organization/spend-alert-validators';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { FormField } from '@/components/ui/form-field';
import { KvRow } from '@/components/ui/kv-row';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatList, formatMoney, formatNumber } from '@/lib/format';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

/** The Notifications screen owns the push gate the channel rows point at. */
const NOTIFICATIONS_HREF = '/(app)/(tabs)/(3_profile)/notifications' as Href;

const WINDOW_LABEL_KEYS = {
  '24': 'spendAlerts.window24h',
  '168': 'spendAlerts.window7d',
  '720': 'spendAlerts.window30d',
} as const;

type WindowOption = keyof typeof WINDOW_LABEL_KEYS;

/** The option matching a stored window; an unsaved scope starts at 24 hours. */
function windowOptionFor(value: number | null | undefined): WindowOption {
  if (value === 168) {
    return '168';
  }
  if (value === 720) {
    return '720';
  }
  return '24';
}

/** The scope's settings: no `organizationId` is the caller's personal scope. */
function useSpendAlertSettings(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.spendAlerts.get.queryOptions(organizationId == null ? {} : { organizationId }, { enabled })
  );
}

/**
 * The save mutation. It deliberately has no error toast: the form renders
 * `spendAlerts.saveError` inline with a Retry and keeps the draft, the
 * inline-error pattern (P2) the low-balance sheet uses for org settings.
 */
function useSaveSpendAlerts() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsFilter = trpc.spendAlerts.get.pathFilter();
  return useMutation(
    trpc.spendAlerts.save.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(settingsFilter);
      },
    })
  );
}

// Every type here is derived from the procedure, so the form cannot drift from
// the wire contract.
type SpendAlertSaveInput = Parameters<ReturnType<typeof useSaveSpendAlerts>['mutate']>[0];
type SpendAlertRuleKind = SpendAlertSaveInput['rules'][number]['kind'];
type SpendAlertSettings = NonNullable<ReturnType<typeof useSpendAlertSettings>['data']>;
type SpendAlertRules = SpendAlertSettings['rules'];
type SpendAlertSpend = SpendAlertSettings['spend'];

type PushOverride = Readonly<{ target: SpendAlertRuleKind; value: boolean }>;

type SpendAlertsScreenProps = Readonly<{
  /** Organization scope from the route; absent is the caller's personal scope. */
  organizationId?: string;
}>;

/**
 * The spend view the spend-alert push opens: the scope's rolling spend, the
 * master switch, and one card per alert kind saved through `spendAlerts.save`.
 * The same screen serves the personal scope and an organization scope — the
 * route decides, never the platform.
 */
export function SpendAlertsScreen({ organizationId }: SpendAlertsScreenProps) {
  const { t } = useTranslation();
  const isOrgScope = organizationId != null;
  const boundary = useOrgBoundary(organizationId);
  // A push or a deep link can name an organization the viewer is not a member
  // of: the boundary owns that case, so the settings query never fires until
  // membership is confirmed.
  const scopeResolved = !isOrgScope || (!boundary.isResolving && boundary.org != null);
  // The tRPC-nested prefix form: the stored key is `[['spendAlerts','get'], …]`,
  // whose first element is the procedure path array. The flat `['spendAlerts']`
  // form compares the string against that array and never matches.
  useRouteForegroundRefresh([[['spendAlerts']]]);
  const query = useSpendAlertSettings(organizationId, scopeResolved);

  if (!scopeResolved) {
    return (
      <OrganizationBoundary
        title={t('notifications.channel.spend')}
        organizationIdOverride={organizationId}
      />
    );
  }

  if (query.isPending) {
    return <SpendAlertsSkeleton />;
  }

  // `data` is kept across a background refetch, so after an error clears the
  // loaded values are still in the resolved branch: a retry never blanks them.
  if (query.isError && query.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('notifications.channel.spend')} />
        <QueryError
          className="bg-background"
          message={t('spendAlerts.loadError')}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </View>
    );
  }

  if (!query.data.canManage) {
    return <PermissionDenied description={t('spendAlerts.permissionDenied')} />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('notifications.channel.spend')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-6 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <SpendAlertsForm
          organizationId={organizationId}
          enabled={query.data.enabled ?? false}
          rules={query.data.rules}
          spend={query.data.spend}
          pushCategoryEnabled={query.data.pushCategoryEnabled}
          pushChannelBlocked={query.data.pushChannelBlocked}
        />
      </TabScreenScrollView>
    </View>
  );
}

type SpendAlertsFormProps = Readonly<{
  organizationId?: string;
  enabled: boolean;
  rules: SpendAlertRules;
  spend: SpendAlertSpend;
  pushCategoryEnabled: boolean;
  pushChannelBlocked: boolean;
}>;

function SpendAlertsForm({
  organizationId,
  enabled: storedEnabled,
  rules,
  spend,
  pushCategoryEnabled,
  pushChannelBlocked,
}: SpendAlertsFormProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const save = useSaveSpendAlerts();

  const threshold = rules?.find(rule => rule.kind === 'threshold');
  const anomaly = rules?.find(rule => rule.kind === 'anomaly');

  // Text lives in refs (iOS: never control an input with state); the switches
  // and the window picker are state because they render their own value.
  const thresholdRef = useRef(
    threshold?.threshold == null
      ? ''
      : formatNumber(threshold.threshold, i18n.language, { useGrouping: false })
  );
  const multiplierRef = useRef(
    anomaly?.multiplierBasisPoints == null
      ? String(DEFAULT_MULTIPLIER)
      : formatNumber(anomaly.multiplierBasisPoints / 100, i18n.language, { useGrouping: false })
  );

  const [enabled, setEnabled] = useState(storedEnabled);
  const [thresholdEnabled, setThresholdEnabled] = useState(threshold?.enabled ?? true);
  const [thresholdEmail, setThresholdEmail] = useState(threshold?.emailEnabled ?? true);
  const [thresholdPush, setThresholdPush] = useState(threshold?.pushEnabled ?? false);
  const [windowOption, setWindowOption] = useState<WindowOption>(() =>
    windowOptionFor(threshold?.windowHours)
  );
  const [anomalyEnabled, setAnomalyEnabled] = useState(anomaly?.enabled ?? true);
  const [anomalyEmail, setAnomalyEmail] = useState(anomaly?.emailEnabled ?? true);
  const [anomalyPush, setAnomalyPush] = useState(anomaly?.pushEnabled ?? false);
  // The saved confirmation. It is rendered as a real Text node on this screen,
  // not left to the toast alone: sonner-native draws outside the accessibility
  // hierarchy, so a toast-only confirmation never reaches assistive tech (and
  // the on-device hierarchy digest). Every draft edit clears it so it can only
  // ever describe the values on screen.
  const [saved, setSaved] = useState(false);

  // The wire requires a limit and a multiplier for both kinds whether or not the
  // kind is enabled, but a kind the owner switched off is not being edited: it
  // does not gate Save, and its payload falls back to a schema-valid stand-in
  // (buildInput below).
  const canSubmitWith = (thresholdOn: boolean, anomalyOn: boolean) =>
    (!thresholdOn || parseThreshold(thresholdRef.current) != null) &&
    (!anomalyOn || parseMultiplier(multiplierRef.current) != null);
  // The master switch off hides the rule cards entirely: no field is on screen
  // to repair, so a draft left invalid before the switch was turned off must not
  // hold Save disabled, or the feature could never be turned off.
  const canSubmit = () => !enabled || canSubmitWith(thresholdEnabled, anomalyEnabled);
  const [canSave, setCanSave] = useState(canSubmit);
  const revalidate = () => {
    setSaved(false);
    setCanSave(canSubmit());
  };

  // Push reaches the viewer only when the rule asks for it, the viewer's own
  // category is on, and the viewer has a registered device. Both gaps are fixed
  // on the Notifications screen (the server writes the category in the same
  // transaction as the rule), so the row sends them there instead of offering a
  // switch that cannot deliver.
  const pushOffByCategory = !pushCategoryEnabled || pushChannelBlocked;

  // The master switch is a draft like every other control: the empty state is
  // only final when it matches what is stored. Once it differs, Save (or Retry)
  // renders with it, otherwise `enabled: false` could never be posted and the
  // feature could never be switched off.
  const masterDirty = enabled !== storedEnabled;

  const spend24h = spend?.spend24hMicrodollars ?? 0;
  const spend7d = spend?.spend7dMicrodollars ?? 0;
  const spendValue =
    spend24h > 0 || spend7d > 0
      ? formatMoney(fromMicrodollars(spend24h), i18n.language)
      : t('spendAlerts.noSpend');

  const windowOptions: readonly { value: WindowOption; label: string }[] = [
    { value: '24', label: t(WINDOW_LABEL_KEYS['24']) },
    { value: '168', label: t(WINDOW_LABEL_KEYS['168']) },
    { value: '720', label: t(WINDOW_LABEL_KEYS['720']) },
  ];

  // What a hidden rule field falls back to when its draft is unusable: the last
  // saved value, kept rather than clobbered by the stand-in. The server's schema
  // already bounded both, so the checks only guard a legacy zero limit.
  const storedThresholdUsd =
    threshold?.threshold != null && threshold.threshold > 0
      ? threshold.threshold
      : DISABLED_THRESHOLD_USD;
  const storedMultiplierTimes =
    anomaly?.multiplierBasisPoints != null && anomaly.multiplierBasisPoints >= 100
      ? anomaly.multiplierBasisPoints / 100
      : DISABLED_MULTIPLIER;

  const buildInput = (pushOverride?: PushOverride): SpendAlertSaveInput | null => {
    const limit = parseThreshold(thresholdRef.current);
    const multiplier = parseMultiplier(multiplierRef.current);
    // A kind the owner switched off — or any kind while the master switch is
    // off and its card is hidden — need not hold a valid value; the wire still
    // wants one per kind, so it falls back to the stored value and then to the
    // smallest value the schema accepts.
    const thresholdHidden = !enabled || !thresholdEnabled;
    const anomalyHidden = !enabled || !anomalyEnabled;
    const thresholdUsd = limit ?? (thresholdHidden ? storedThresholdUsd : null);
    const multiplierTimes = multiplier ?? (anomalyHidden ? storedMultiplierTimes : null);
    if (thresholdUsd == null || multiplierTimes == null) {
      return null;
    }
    return {
      ...(organizationId == null ? {} : { organizationId }),
      enabled,
      rules: [
        {
          kind: 'threshold',
          enabled: thresholdEnabled,
          threshold: thresholdUsd,
          windowHours: toWindowHours(Number(windowOption)),
          emailEnabled: thresholdEmail,
          pushEnabled: pushOverride?.target === 'threshold' ? pushOverride.value : thresholdPush,
        },
        {
          kind: 'anomaly',
          enabled: anomalyEnabled,
          multiplierBasisPoints: multiplierBasisPoints(multiplierTimes),
          emailEnabled: anomalyEmail,
          pushEnabled: pushOverride?.target === 'anomaly' ? pushOverride.value : anomalyPush,
        },
      ],
    };
  };

  const onSave = () => {
    const input = buildInput();
    if (input == null) {
      return;
    }
    save.mutate(input, {
      onSuccess: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // No toast here: the confirmation below the fields is the single
        // announcement owner (AccessibleStatus), and it describes the values
        // that are still on screen. A toast would announce the same sentence a
        // second time and draw a second copy of it. The owner leaves through
        // the header's back control.
        setSaved(true);
      },
    });
  };

  const onPushChange = (
    target: SpendAlertRuleKind,
    next: boolean,
    apply: (value: boolean) => void
  ) => {
    void Haptics.selectionAsync();
    setSaved(false);
    apply(next);
    // Toggling push also writes the caller's notification category (the
    // server's agreement between the rule channel and the category), so the
    // Notifications screen cannot disagree. Only a valid draft can be sent; an
    // invalid one waits for Save, which owns the inline field errors.
    const input = buildInput({ target, value: next });
    if (input != null) {
      save.mutate(input);
    }
  };

  // save has no mutation toast — success or failure (inline error pattern P2)
  // — so AccessibleStatus is the single announcement owner on both platforms:
  // on success it carries the confirmation as a real Text node, on failure the
  // error, and a failure keeps the draft and offers Retry. A failure outranks
  // the last confirmation.
  const confirmedMessage = saved ? t('spendAlerts.saved') : null;
  const saveMessage = save.isError ? t('spendAlerts.saveError') : confirmedMessage;

  const saveControls = (
    <>
      {/* The slot is reserved whether or not a message shows: the confirmation
          and the error swap in place, so the Save button below never moves
          when the save settles. */}
      <View className="min-h-5 justify-center">
        <AccessibleStatus
          message={saveMessage}
          tone={save.isError ? 'error' : 'status'}
          className="text-sm"
        />
      </View>

      {save.isError && (
        <Button
          variant="outline"
          accessibilityLabel={t('common.retry')}
          loading={save.isPending}
          // An edit after the failure can leave the draft unsubmittable while
          // the error is still showing; Retry retries whatever is on screen, so
          // it carries the same gate as Save rather than no-op'ing silently.
          disabled={!canSave}
          onPress={onSave}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      )}

      <Button disabled={!canSave} loading={save.isPending} onPress={onSave}>
        <Text className="text-primary-foreground">{t('common.save')}</Text>
      </Button>
    </>
  );

  return (
    <>
      <Text variant="muted" className="text-sm">
        {t('spendAlerts.subtitle')}
      </Text>

      <View className="rounded-lg bg-secondary px-3">
        <KvRow label={t('spendAlerts.spend24h')} value={spendValue} last />
      </View>

      <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
        <Text className="text-sm font-medium">{t('common.enabled')}</Text>
        <Switch
          accessibilityLabel={t('spendAlerts.enable')}
          value={enabled}
          onValueChange={value => {
            void Haptics.selectionAsync();
            setSaved(false);
            setEnabled(value);
            // Off hides the rule fields, so they stop gating Save; on restores
            // their gate with whatever the fields currently hold.
            setCanSave(value ? canSubmitWith(thresholdEnabled, anomalyEnabled) : true);
          }}
        />
      </View>

      {enabled ? (
        <>
          <RuleCard
            title={t('spendAlerts.thresholdTitle')}
            subtitle={t('spendAlerts.thresholdSubtitle')}
            enabled={thresholdEnabled}
            onEnabledChange={value => {
              void Haptics.selectionAsync();
              setSaved(false);
              setThresholdEnabled(value);
              // Switching the kind off drops its field from the Save gate.
              setCanSave(canSubmitWith(value, anomalyEnabled));
            }}
            emailEnabled={thresholdEmail}
            onEmailChange={value => {
              setSaved(false);
              setThresholdEmail(value);
            }}
            pushEnabled={thresholdPush}
            onPushChange={next => {
              onPushChange('threshold', next, setThresholdPush);
            }}
            pushOffByCategory={pushOffByCategory}
            onOpenNotifications={() => {
              router.push(NOTIFICATIONS_HREF);
            }}
          >
            <FormField
              label={t('spendAlerts.limitLabel')}
              required={thresholdEnabled}
              placeholder="25.00"
              keyboardType="decimal-pad"
              defaultValue={thresholdRef.current || undefined}
              validate={thresholdEnabled ? thresholdError : undefined}
              onChangeText={value => {
                thresholdRef.current = value;
                revalidate();
              }}
            />
            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">
                {t('spendAlerts.windowLabel')}
              </Text>
              <SegmentedControl<WindowOption>
                accessibilityLabel={t('spendAlerts.windowLabel')}
                options={windowOptions}
                value={windowOption}
                onChange={value => {
                  setSaved(false);
                  setWindowOption(value);
                }}
              />
            </View>
          </RuleCard>

          <RuleCard
            title={t('spendAlerts.anomalyTitle')}
            subtitle={t('spendAlerts.anomalySubtitle')}
            enabled={anomalyEnabled}
            onEnabledChange={value => {
              void Haptics.selectionAsync();
              setSaved(false);
              setAnomalyEnabled(value);
              // Switching the kind off drops its field from the Save gate.
              setCanSave(canSubmitWith(thresholdEnabled, value));
            }}
            emailEnabled={anomalyEmail}
            onEmailChange={value => {
              setSaved(false);
              setAnomalyEmail(value);
            }}
            pushEnabled={anomalyPush}
            onPushChange={next => {
              onPushChange('anomaly', next, setAnomalyPush);
            }}
            pushOffByCategory={pushOffByCategory}
            onOpenNotifications={() => {
              router.push(NOTIFICATIONS_HREF);
            }}
          >
            <FormField
              label={t('spendAlerts.multiplierLabel')}
              required={anomalyEnabled}
              placeholder={String(DEFAULT_MULTIPLIER)}
              keyboardType="decimal-pad"
              defaultValue={multiplierRef.current || undefined}
              validate={anomalyEnabled ? multiplierError : undefined}
              onChangeText={value => {
                multiplierRef.current = value;
                revalidate();
              }}
            />
          </RuleCard>

          {/* save has no mutation toast (inline error pattern P2), so
              AccessibleStatus is the single announcement owner here. */}
          {saveControls}
        </>
      ) : (
        <>
          <Text variant="muted" className="text-sm">
            {t('spendAlerts.empty')}
          </Text>
          {/* A disable save lands with the stored value now false, so
              `masterDirty` clears on its own refetch. Keep the controls while a
              confirmation is live, or the saved line (and its reserved slot)
              would vanish the moment the save settles. An edit clears `saved`
              (setSaved(false)), which returns this branch to the master switch
              alone. */}
          {masterDirty || saved ? saveControls : null}
        </>
      )}
    </>
  );
}

type RuleCardProps = Readonly<{
  title: string;
  subtitle: string;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  emailEnabled: boolean;
  onEmailChange: (value: boolean) => void;
  pushEnabled: boolean;
  onPushChange: (value: boolean) => void;
  pushOffByCategory: boolean;
  onOpenNotifications: () => void;
  children: ReactNode;
}>;

/** One alert kind: its enable switch, its kind-specific fields, its channels. */
function RuleCard({
  title,
  subtitle,
  enabled,
  onEnabledChange,
  emailEnabled,
  onEmailChange,
  pushEnabled,
  onPushChange,
  pushOffByCategory,
  onOpenNotifications,
  children,
}: RuleCardProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  // The OS accessibility hierarchy does not group a switch with the card above
  // it, and both cards render an Email and a Push switch. Naming the kind
  // alongside the channel keeps each control addressable on its own, like the
  // Notifications screen's dedicated `spendAlertsToggle` label.
  const emailLabel = formatList([title, t('common.email')], i18n.language);
  const pushLabel = formatList([title, t('notifications.push')], i18n.language);

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium">{title}</Text>
          <Text variant="muted" className="mt-0.5 text-xs">
            {subtitle}
          </Text>
        </View>
        <Switch accessibilityLabel={title} value={enabled} onValueChange={onEnabledChange} />
      </View>

      {children}

      <View className="rounded-lg bg-secondary px-3">
        <View className="min-h-11 flex-row items-center justify-between border-b-[0.5px] border-hair-soft">
          <Text className="text-sm">{t('common.email')}</Text>
          {/* The row's own label names the channel; the card's kind is composed
              into the switch label, so the two Email rows stay distinct. */}
          <Switch
            accessibilityLabel={emailLabel}
            value={emailEnabled}
            onValueChange={onEmailChange}
          />
        </View>
        {pushOffByCategory ? (
          <Pressable
            onPress={onOpenNotifications}
            accessibilityRole="button"
            className="min-h-11 flex-row items-center justify-between active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">{t('notifications.push')}</Text>
            <View className="flex-row items-center gap-1">
              <Text className="text-xs text-muted-foreground">
                {t('spendAlerts.pushOffByCategory')}
              </Text>
              <DirectionalChevronRight size={14} color={colors.mutedForeground} />
            </View>
          </Pressable>
        ) : (
          <View className="min-h-11 flex-row items-center justify-between">
            <Text className="text-sm">{t('notifications.push')}</Text>
            <Switch
              accessibilityLabel={pushLabel}
              value={pushEnabled}
              onValueChange={onPushChange}
            />
          </View>
        )}
      </View>
    </View>
  );
}

function RuleCardSkeleton() {
  return (
    <View className="gap-3">
      <Skeleton className="h-[68px] rounded-lg" />
      <View className="gap-1.5">
        <Skeleton className="h-3.5 w-24 rounded" />
        <Skeleton className="h-11 rounded-md" />
      </View>
      <Skeleton className="h-[92px] rounded-lg" />
    </View>
  );
}

/** Skeleton at the loaded rows' size, so the swap moves nothing. */
function SpendAlertsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('notifications.channel.spend')} />
      <ScrollView className="flex-1" contentContainerClassName="px-6 gap-6 pb-8 pt-4">
        <Skeleton className="h-4 w-64 rounded" />
        <Skeleton className="h-[52px] rounded-lg" />
        <Skeleton className="h-[56px] rounded-lg" />
        <RuleCardSkeleton />
        <RuleCardSkeleton />
        <Skeleton className="h-11 rounded-md" />
      </ScrollView>
    </View>
  );
}
