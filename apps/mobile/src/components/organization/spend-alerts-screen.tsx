/* eslint-disable max-lines -- The spend view composes the scope boundary, the four
load states, and two rule cards with their channel rows in one surface; splitting
the pieces would re-encode the same draft state across files. */

import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { notificationHaptic, selectionHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { z } from 'zod';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import {
  DEFAULT_MULTIPLIER,
  DISABLED_MULTIPLIER,
  DISABLED_THRESHOLD_USD,
  multiplierBasisPoints,
  multiplierError,
  multiplierErrorMessages,
  parseMultiplier,
  parseThreshold,
  thresholdError,
  thresholdErrorMessages,
  thresholdPlaceholder,
  toWindowHours,
} from '@/components/organization/spend-alert-validators';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { KvRow } from '@/components/ui/kv-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatList, formatNumber, formatPrefixedMoney } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { spendAlertsFormDraftKey } from '@/lib/persist/drafts';
import { useFormDraft } from '@/lib/persist/use-form-draft';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/** The Notifications screen owns the push gate the channel rows point at. */
const NOTIFICATIONS_HREF = '/(app)/notifications' as Href;

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

/** A stored window option, or `fallback` for a value this build does not know. */
function windowOptionOr(value: string | undefined, fallback: WindowOption): WindowOption {
  return value != null && Object.hasOwn(WINDOW_LABEL_KEYS, value)
    ? (value as WindowOption)
    : fallback;
}

/**
 * The whole form on screen. A language change that flips the text direction
 * reloads the JS bundle without running cleanup, so the typed text and the
 * switches are persisted here instead of living only in this component.
 */
export type SpendAlertsFormDraft = {
  threshold: string;
  multiplier: string;
  enabled: boolean;
  thresholdEnabled: boolean;
  thresholdEmail: boolean;
  thresholdPush: boolean;
  windowOption: string;
  anomalyEnabled: boolean;
  anomalyEmail: boolean;
  anomalyPush: boolean;
};

const spendAlertsFormDraftSchema = z.object({
  threshold: z.string(),
  multiplier: z.string(),
  enabled: z.boolean(),
  thresholdEnabled: z.boolean(),
  thresholdEmail: z.boolean(),
  thresholdPush: z.boolean(),
  windowOption: z.string(),
  anomalyEnabled: z.boolean(),
  anomalyEmail: z.boolean(),
  anomalyPush: z.boolean(),
});

/** Shape guard for a stored draft; a value another build wrote stays stored. */
export function isSpendAlertsFormDraft(value: unknown): value is SpendAlertsFormDraft {
  return spendAlertsFormDraftSchema.safeParse(value).success;
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
function useSaveSpendAlerts(onSaved: (posted: SpendAlertSaveInput) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsFilter = trpc.spendAlerts.get.pathFilter();
  return useMutation(
    trpc.spendAlerts.save.mutationOptions({
      // The posted input travels to `onSaved`, so the form can tell whether the
      // draft it sent is still the one on screen.
      onSuccess: async (_data, posted) => {
        // The row now holds what the draft held, so the draft is dropped before
        // the refetch settles: a restored copy could otherwise outlive the
        // record it was typed over.
        onSaved(posted);
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
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  // The form's own record key: a draft typed on one scope never seeds another.
  const draft = useFormDraft<SpendAlertsFormDraft>({
    userId,
    isIdentityLoading,
    entityKey: spendAlertsFormDraftKey(organizationId),
    validate: isSpendAlertsFormDraft,
  });
  // The stored row is already on screen when the draft finishes loading, so the
  // form mounts on the server values and applies a restored draft itself, once,
  // while the person has not edited.
  const restored = draft.kind === 'ready' ? draft.value : null;
  // The form is typed into before the store answers — the stored row paints
  // first — and `useFormDraft` holds such a write and replays it once the draft
  // answers, so these forward whenever the hook has them.
  const onDraftChange = (value: SpendAlertsFormDraft) => {
    if (draft.kind === 'ready') {
      draft.save(value);
    }
  };
  const onDraftClear = () => {
    if (draft.kind === 'ready') {
      draft.clear();
    }
  };

  if (!scopeResolved) {
    return (
      <OrganizationBoundary
        title={t('notifications.channel.spend')}
        backFallback={PROFILE_TAB_HREF}
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
        <ScreenHeader title={t('notifications.channel.spend')} backFallback={PROFILE_TAB_HREF} />
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
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('notifications.channel.spend')} backFallback={PROFILE_TAB_HREF} />
        <PermissionDenied description={t('spendAlerts.permissionDenied')} showBack={false} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('notifications.channel.spend')} backFallback={PROFILE_TAB_HREF} />
      <TabScreenScrollView
        // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <SpendAlertsForm
          organizationId={organizationId}
          scope={query.data.scope}
          scopeName={query.data.scopeName}
          enabled={query.data.enabled ?? false}
          rules={query.data.rules}
          spend={query.data.spend}
          pushCategoryEnabled={query.data.pushCategoryEnabled}
          pushChannelBlocked={query.data.pushChannelBlocked}
          restored={restored}
          onDraftChange={onDraftChange}
          onDraftClear={onDraftClear}
        />
      </TabScreenScrollView>
    </View>
  );
}

type SpendAlertsFormProps = Readonly<{
  organizationId?: string;
  /** The scope the router read: the caller's own account or an organization. */
  scope: SpendAlertSettings['scope'];
  /** The owner's display name for that scope (the caller's name, or the org's). */
  scopeName: string;
  enabled: boolean;
  rules: SpendAlertRules;
  spend: SpendAlertSpend;
  pushCategoryEnabled: boolean;
  pushChannelBlocked: boolean;
  /** The durable draft once it loaded; null while it loads or when none is stored. */
  restored: SpendAlertsFormDraft | null;
  /** Persist the whole draft on every edit. */
  onDraftChange: (value: SpendAlertsFormDraft) => void;
  /** Drop the stored draft: the save landed, or the person discarded it. */
  onDraftClear: () => void;
}>;

function SpendAlertsForm({
  organizationId,
  scope,
  scopeName,
  enabled: storedEnabled,
  rules,
  spend,
  pushCategoryEnabled,
  pushChannelBlocked,
  restored,
  onDraftChange,
  onDraftClear,
}: SpendAlertsFormProps) {
  const router = useRouter();
  const { t } = useTranslation();
  // The screen serves both the caller's own account and an organization; the
  // copy alone never says which one an alert watches, so the scope line names
  // the owner. The labels are the shared Account / Organization keys.
  const scopeLabel = scope === 'organization' ? t('common.organization') : t('preferences.account');

  const threshold = rules?.find(rule => rule.kind === 'threshold');
  const anomaly = rules?.find(rule => rule.kind === 'anomaly');

  // Text lives in refs (iOS: never control an input with state); the switches
  // and the window picker are state because they render their own value. A
  // restored draft outranks the stored row for the first value of each: it is
  // what the person had on screen when the bundle reloaded.
  const storedThresholdText =
    threshold?.threshold == null
      ? ''
      : formatNumber(threshold.threshold, i18n.language, { useGrouping: false });
  const storedMultiplierText =
    anomaly?.multiplierBasisPoints == null
      ? String(DEFAULT_MULTIPLIER)
      : formatNumber(anomaly.multiplierBasisPoints / 100, i18n.language, { useGrouping: false });
  const thresholdRef = useRef(restored?.threshold ?? storedThresholdText);
  const multiplierRef = useRef(restored?.multiplier ?? storedMultiplierText);

  const [enabled, setEnabled] = useState(restored?.enabled ?? storedEnabled);
  const [thresholdEnabled, setThresholdEnabled] = useState(
    restored?.thresholdEnabled ?? threshold?.enabled ?? true
  );
  const [thresholdEmail, setThresholdEmail] = useState(
    restored?.thresholdEmail ?? threshold?.emailEnabled ?? true
  );
  const [thresholdPush, setThresholdPush] = useState(
    restored?.thresholdPush ?? threshold?.pushEnabled ?? false
  );
  const [windowOption, setWindowOption] = useState<WindowOption>(() =>
    windowOptionOr(restored?.windowOption, windowOptionFor(threshold?.windowHours))
  );
  const [anomalyEnabled, setAnomalyEnabled] = useState(
    restored?.anomalyEnabled ?? anomaly?.enabled ?? true
  );
  const [anomalyEmail, setAnomalyEmail] = useState(
    restored?.anomalyEmail ?? anomaly?.emailEnabled ?? true
  );
  const [anomalyPush, setAnomalyPush] = useState(
    restored?.anomalyPush ?? anomaly?.pushEnabled ?? false
  );
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

  // A draft that lands after this form mounted cannot seed the uncontrolled
  // inputs: iOS reads `defaultValue` once, at mount (AGENTS.md). So the restore
  // writes the refs and the state and bumps `formKey`, which remounts the field
  // block once so its inputs re-read `defaultValue` — and only while the person
  // has not typed, because their text always wins over a restored draft.
  const [formKey, setFormKey] = useState(0);
  const touchedRef = useRef(false);
  const restoredAppliedRef = useRef(restored != null);
  useEffect(() => {
    if (restored == null || touchedRef.current || restoredAppliedRef.current) {
      return;
    }
    restoredAppliedRef.current = true;
    thresholdRef.current = restored.threshold;
    multiplierRef.current = restored.multiplier;
    setEnabled(restored.enabled);
    setThresholdEnabled(restored.thresholdEnabled);
    setThresholdEmail(restored.thresholdEmail);
    setThresholdPush(restored.thresholdPush);
    setWindowOption(windowOptionOr(restored.windowOption, windowOptionFor(threshold?.windowHours)));
    setAnomalyEnabled(restored.anomalyEnabled);
    setAnomalyEmail(restored.anomalyEmail);
    setAnomalyPush(restored.anomalyPush);
    setSaved(false);
    setCanSave(
      !restored.enabled ||
        ((!restored.thresholdEnabled || parseThreshold(restored.threshold) != null) &&
          (!restored.anomalyEnabled || parseMultiplier(restored.multiplier) != null))
    );
    setFormKey(key => key + 1);
  }, [restored, threshold]);

  // Every edit persists the whole form, not one field: the stored draft always
  // describes what is on screen, so the restore needs no field-by-field rules.
  const currentDraft = (update: Partial<SpendAlertsFormDraft>): SpendAlertsFormDraft => ({
    threshold: thresholdRef.current,
    multiplier: multiplierRef.current,
    enabled,
    thresholdEnabled,
    thresholdEmail,
    thresholdPush,
    windowOption,
    anomalyEnabled,
    anomalyEmail,
    anomalyPush,
    ...update,
  });
  const editDraft = (update: Partial<SpendAlertsFormDraft>) => {
    touchedRef.current = true;
    setSaved(false);
    onDraftChange(currentDraft(update));
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
  const hasSpend = spend24h > 0 || spend7d > 0;
  const spendValue = hasSpend
    ? formatPrefixedMoney(fromMicrodollars(spend24h), i18n.language)
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

  const save = useSaveSpendAlerts(posted => {
    // Only a save whose draft is still the one on screen may drop it: an edit
    // made while the request was in flight belongs to the person, and clearing
    // would throw that away on the request's success. `buildInput` reads the
    // live refs and state, so comparing what the form would post now with what
    // it did post is exact.
    const current = buildInput();
    if (current !== null && JSON.stringify(current) === JSON.stringify(posted)) {
      onDraftClear();
    }
  });

  const onSave = () => {
    const input = buildInput();
    if (input == null) {
      return;
    }
    save.mutate(input, {
      onSuccess: () => {
        notificationHaptic(Haptics.NotificationFeedbackType.Success);
        // No toast here: the confirmation below the fields is the single
        // announcement owner (AccessibleStatus), and it describes the values
        // that are still on screen. A toast would announce the same sentence a
        // second time and draw a second copy of it. The owner leaves through
        // the header's back control.
        setSaved(true);
      },
    });
  };
  const onPushChange = ({
    target,
    next,
    apply,
    draftPatch,
  }: {
    target: SpendAlertRuleKind;
    next: boolean;
    apply: (value: boolean) => void;
    draftPatch: Partial<SpendAlertsFormDraft>;
  }) => {
    selectionHaptic();
    apply(next);
    editDraft(draftPatch);
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
        <Text>{t('common.save')}</Text>
      </Button>
    </>
  );

  return (
    <>
      <Text variant="muted" className="text-sm">
        {t('spendAlerts.subtitle')}
      </Text>

      <RowGroup>
        {/* The owner of the alert is a name, not an identifier: it paints in the
            sans face, like the row label and the empty amount below it, while
            the amount keeps the code face because that is the value someone
            copies. The name stays selectable all the same. */}
        <KvRow label={scopeLabel} value={scopeName} valueFace="text" selectable />
        {/* A selectable value is exempt from the row's one-line clamp (Android's
            selection path re-applies selection and drops it), so only the amount
            — the value someone copies — is selectable. The empty placeholder is
            a sentence, so it paints in the sans face: monospace there reads as a
            value and wraps the row on a compact phone. */}
        <KvRow
          label={t('spendAlerts.spend24h')}
          value={spendValue}
          valueFace={hasSpend ? 'mono' : 'text'}
          // An amount's symbol is neutral to the paragraph's direction, so the
          // run carries its own left-to-right order; the empty placeholder is a
          // sentence and keeps the paragraph's.
          valueDirection={hasSpend ? 'ltr' : undefined}
          selectable={hasSpend}
        />
      </RowGroup>

      {/* The master switch sits in its own group, in the shared switch-row
          anatomy: the row's own inset holds the switch level with its label. */}
      <RowGroup>
        <PreferenceRow
          title={t('spendAlerts.sendAlerts')}
          value={enabled}
          disabled={false}
          onValueChange={value => {
            setEnabled(value);
            // Off hides the rule fields, so they stop gating Save; on restores
            // their gate with whatever the fields currently hold.
            setCanSave(value ? canSubmitWith(thresholdEnabled, anomalyEnabled) : true);
            editDraft({ enabled: value });
          }}
        />
      </RowGroup>

      {enabled ? (
        // `formKey` remounts this block when a restored draft lands after mount:
        // the text fields are uncontrolled, so only a fresh mount re-reads their
        // `defaultValue` (the comment at `formKey` above says why).
        <View key={formKey} className="gap-6">
          <RuleCard
            title={t('spendAlerts.thresholdTitle')}
            subtitle={t('spendAlerts.thresholdSubtitle')}
            enabled={thresholdEnabled}
            onEnabledChange={value => {
              selectionHaptic();
              setThresholdEnabled(value);
              // Switching the kind off drops its field from the Save gate.
              setCanSave(canSubmitWith(value, anomalyEnabled));
              editDraft({ thresholdEnabled: value });
            }}
            emailEnabled={thresholdEmail}
            onEmailChange={value => {
              setThresholdEmail(value);
              editDraft({ thresholdEmail: value });
            }}
            pushEnabled={thresholdPush}
            onPushChange={next => {
              onPushChange({
                target: 'threshold',
                next,
                apply: setThresholdPush,
                draftPatch: { thresholdPush: next },
              });
            }}
            pushOffByCategory={pushOffByCategory}
            onOpenNotifications={() => {
              router.push(NOTIFICATIONS_HREF);
            }}
          >
            <FormField
              label={t('spendAlerts.limitLabel')}
              required={thresholdEnabled}
              validateWhileTyping
              placeholder={thresholdPlaceholder()}
              keyboardType="decimal-pad"
              defaultValue={thresholdRef.current || undefined}
              validate={thresholdEnabled ? thresholdError : undefined}
              reserveErrorMessages={thresholdEnabled ? thresholdErrorMessages() : undefined}
              onChangeText={value => {
                thresholdRef.current = value;
                editDraft({});
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
                  setWindowOption(value);
                  editDraft({ windowOption: value });
                }}
              />
            </View>
          </RuleCard>

          <RuleCard
            title={t('spendAlerts.anomalyTitle')}
            subtitle={t('spendAlerts.anomalySubtitle')}
            enabled={anomalyEnabled}
            onEnabledChange={value => {
              selectionHaptic();
              setAnomalyEnabled(value);
              // Switching the kind off drops its field from the Save gate.
              setCanSave(canSubmitWith(thresholdEnabled, value));
              editDraft({ anomalyEnabled: value });
            }}
            emailEnabled={anomalyEmail}
            onEmailChange={value => {
              setAnomalyEmail(value);
              editDraft({ anomalyEmail: value });
            }}
            pushEnabled={anomalyPush}
            onPushChange={next => {
              onPushChange({
                target: 'anomaly',
                next,
                apply: setAnomalyPush,
                draftPatch: { anomalyPush: next },
              });
            }}
            pushOffByCategory={pushOffByCategory}
            onOpenNotifications={() => {
              router.push(NOTIFICATIONS_HREF);
            }}
          >
            <FormField
              label={t('spendAlerts.multiplierLabel')}
              required={anomalyEnabled}
              validateWhileTyping
              placeholder={String(DEFAULT_MULTIPLIER)}
              keyboardType="decimal-pad"
              defaultValue={multiplierRef.current || undefined}
              validate={anomalyEnabled ? multiplierError : undefined}
              reserveErrorMessages={anomalyEnabled ? multiplierErrorMessages() : undefined}
              onChangeText={value => {
                multiplierRef.current = value;
                editDraft({});
                revalidate();
              }}
            />
          </RuleCard>

          {/* save has no mutation toast (inline error pattern P2), so
              AccessibleStatus is the single announcement owner here. */}
          {saveControls}
        </View>
      ) : (
        <>
          {/* The switch row above is the whole off state: it already says alerts
              are off, and the subtitle names who they reach. A disable save
              lands with the stored value now false, so
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

type CardSwitchProps = Readonly<{
  accessibilityLabel: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
}>;

/**
 * The card header's switch, in the shared trailing cell.
 *
 * The card ends its content at `px-3` = 10.5dp (the native rem here is 14dp),
 * and the label's ink starts about 10dp in. An unpulled switch's painted end
 * (the thumb at its travel limit, about 3dp past the track's own end) lands
 * about 14dp from the card edge, visibly deeper than the label. Pulling the
 * cell out by one spacing unit (`-me-1` = 3.5dp) puts the painted thumb end
 * about 10–11dp from the edge, level with the label's start, and keeps about
 * 7dp of the node's hit area inside the card.
 *
 * The pull is on the END edge, so it stays logical: `marginInlineEnd` follows
 * the writing direction, where a hand-picked `-mr-1` would land on the label's
 * side under RTL. The control itself goes through `renderRowTrailing`, which
 * cancels the node's 44pt floor down to a row's content band, so the card
 * header keeps the height of its two text lines instead of the control's.
 */
function CardSwitch({ accessibilityLabel, value, onValueChange }: CardSwitchProps) {
  return (
    <View className="-me-1">
      {renderRowTrailing({ kind: 'switch', value, onValueChange, accessibilityLabel })}
    </View>
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

  // The OS accessibility hierarchy does not group a switch with the card above
  // it, and both cards render an Email and a Push switch. Naming the kind
  // alongside the channel keeps each control addressable on its own, like the
  // Notifications screen's dedicated `spendAlertsToggle` label.
  const emailLabel = formatList([title, t('common.email')], i18n.language);
  const pushLabel = formatList([title, t('notifications.push')], i18n.language);

  return (
    <View className="gap-3">
      <Card>
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-medium text-foreground">{title}</Text>
            <Text variant="caption" className="mt-0.5">
              {subtitle}
            </Text>
          </View>
          <CardSwitch accessibilityLabel={title} value={enabled} onValueChange={onEnabledChange} />
        </View>

        {children}
      </Card>

      {/* The channel rows are their own grouped block beside the card, never a
          card inside a card: the row inset is the group's, so the switch ends
          level with the label without the card's pull. */}
      <RowGroup>
        <PreferenceRow
          title={t('common.email')}
          value={emailEnabled}
          disabled={false}
          // The row's own label names the channel; the card's kind is composed
          // into the switch label, so the two Email rows stay distinct.
          accessibilityLabel={emailLabel}
          onValueChange={onEmailChange}
        />
        {pushOffByCategory ? (
          <RowFrame
            title={t('notifications.push')}
            onPress={onOpenNotifications}
            trailing={{
              kind: 'node',
              node: (
                <View className="min-w-0 shrink flex-row items-center gap-2">
                  <Text variant="caption" className="shrink">
                    {t('spendAlerts.pushOffByCategory')}
                  </Text>
                  <RowChevron />
                </View>
              ),
            }}
          />
        ) : (
          <PreferenceRow
            title={t('notifications.push')}
            value={pushEnabled}
            disabled={false}
            accessibilityLabel={pushLabel}
            onValueChange={onPushChange}
          />
        )}
      </RowGroup>
    </View>
  );
}

function RuleCardSkeleton() {
  return (
    <View className="gap-3">
      <Card>
        <RowSkeleton subtitle trailing="switch" />
        <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full rounded-md bg-muted-soft')} />
      </Card>
      <RowGroup>
        <RowSkeleton trailing="switch" />
        <RowSkeleton trailing="switch" />
      </RowGroup>
    </View>
  );
}

/** Skeleton at the loaded rows' size, so the swap moves nothing. */
function SpendAlertsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('notifications.channel.spend')} backFallback={PROFILE_TAB_HREF} />
      <ScrollView className="flex-1" contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-8')}>
        <Skeleton className="h-4 w-64 rounded" />
        <RowGroup>
          <RowSkeleton />
          <RowSkeleton />
        </RowGroup>
        <RowGroup>
          <RowSkeleton trailing="switch" />
        </RowGroup>
        <RuleCardSkeleton />
        <RuleCardSkeleton />
        <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full rounded-md bg-muted-soft')} />
      </ScrollView>
    </View>
  );
}
