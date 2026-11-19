/* eslint-disable max-lines -- the reason/comment draft state and the load-failure gates share one screen harness; the paused-offline gate joins the existing error and loading gates */
import { useRouter } from 'expo-router';
import { ShieldOff } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RefusalStatus } from '@/components/refusal-status';
import { ScreenHeader } from '@/components/screen-header';
import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { DismissFindingSkeleton } from '@/components/security-agent/dismiss-finding-skeleton';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type DismissFailure,
  isDismissFailureRetryable,
  resolveDismissFailure,
} from '@/components/security-agent/dismiss-finding-failure';
import { useSecurityAgentCapability } from '@/lib/hooks/use-security-agent';
import {
  isSecurityTrialRefusal,
  isSecurityTrialRefusalCopyKey,
  securityMutationCopyKey,
} from '@/lib/security-agent-ledger';
import { useSecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';
import { useDismissSecurityFinding, useSecurityFinding } from '@/lib/hooks/use-security-findings';
import { useMutedDisabledInk, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useBillingAction, useCanManageBilling } from '@/lib/trial-refusal';

// The five GitHub dismissal reasons the backend's DismissReasonSchema accepts
// (apps/web/src/lib/security-agent/core/schemas.ts:13-19) — exact value/label
// pairs from the task brief, matching web's dismissal reason picker.
const DISMISS_REASONS = [
  { value: 'fix_started', labelKey: 'securityAgent.dismiss.reasonFixStarted' },
  { value: 'no_bandwidth', labelKey: 'securityAgent.dismiss.reasonNoBandwidth' },
  { value: 'tolerable_risk', labelKey: 'securityAgent.dismiss.reasonTolerableRisk' },
  { value: 'inaccurate', labelKey: 'securityAgent.dismiss.reasonInaccurate' },
  { value: 'not_used', labelKey: 'securityAgent.dismiss.reasonNotUsed' },
] as const;

type DismissReason = (typeof DISMISS_REASONS)[number]['value'];

function isDismissReason(value: string): value is DismissReason {
  return DISMISS_REASONS.some(reason => reason.value === value);
}

type DismissFindingScreenProps = {
  scope: string;
  findingId: string;
};

/**
 * A first read the online manager paused (connectivity down or unsettled) can
 * never finish: the loading gate would hold the skeleton until connectivity
 * returns. Name the connection and offer Retry for each read the form waits on.
 */
function pausedOfflineRead(query: {
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}): boolean {
  return query.isPending && query.fetchStatus === 'paused';
}

export function DismissFindingScreen({ scope, findingId }: Readonly<DismissFindingScreenProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const mutedDisabledInk = useMutedDisabledInk();
  // This header is inside a formSheet route: the sheet edge owns the top
  // clearance unless the sheet is the stack's first screen.
  const modalTopInset = useFormSheetHeaderTopInset();
  const capability = useSecurityAgentCapability(scope);
  const findingQuery = useSecurityFinding(scope, findingId);
  const [reason, setReason] = useState<DismissReason | null>(null);
  const commentRef = useRef('');
  const dismissFinding = useDismissSecurityFinding(scope);
  const dismissDraft = useSecurityDismissDraft(scope, findingId);
  // The reader's role, read once: the mapping that built `dismissFinding.error`
  // took the same role read, and the draft records which refusal it was rather
  // than which reader saw it, so the stored sentence is re-translated for this
  // reader while `useBillingAction` offers the step from the same predicate.
  const canManageBilling = useCanManageBilling(scope);
  const billingAction = useBillingAction(scope);

  // Restore the reason and comment from the stored draft once, so a retry
  // reopens the form with the user's last intent. The form renders only after
  // hydration, so the first render already carries the restored values.
  const prefillAppliedRef = useRef(false);
  useEffect(() => {
    if (!dismissDraft.hydrated || prefillAppliedRef.current) {
      return;
    }
    prefillAppliedRef.current = true;
    const draft = dismissDraft.draft;
    if (draft) {
      if (isDismissReason(draft.reason)) {
        setReason(draft.reason);
      }
      commentRef.current = draft.comment;
    }
  }, [dismissDraft.hydrated, dismissDraft.draft]);

  const onSubmit = () => {
    if (!reason) {
      return;
    }
    const comment = commentRef.current.trim();
    // Record the intent before the request so a pre-accept failure (no
    // command id) leaves a durable draft the retry card can restore.
    dismissDraft.persist({ reason, comment, lastError: null, retryable: null, lastErrorKey: null });
    dismissFinding.mutate(
      { findingId, reason, comment: comment || undefined },
      {
        // Pop only once the command is accepted — the scope command observer
        // reports the terminal (success/failure) toast once it resolves.
        onSuccess: () => {
          // Authoritative accept: the intent is recorded server-side, so the
          // durable draft is no longer needed.
          dismissDraft.clear();
          router.back();
        },
        onError: error => {
          dismissDraft.persist({
            reason,
            comment,
            lastError: error.message,
            lastErrorKey: securityMutationCopyKey(error, canManageBilling),
            retryable: isDismissFailureRetryable(error),
          });
        },
      }
    );
  };

  // Persist the reason and comment as the user types (debounced by the drafts
  // module), so a typed draft survives leave and reopen without a submit. The
  // existing `lastError`/`lastErrorKey`/`retryable` are preserved: editing an
  // unresolved failure must not clear the retry card until the user re-submits.
  const persistOnType = (nextReason: DismissReason | null, nextComment: string) => {
    const existing = dismissDraft.draft;
    dismissDraft.persist({
      reason: nextReason ?? '',
      comment: nextComment,
      lastError: existing?.lastError ?? null,
      lastErrorKey: existing?.lastErrorKey ?? null,
      retryable: existing?.retryable ?? null,
    });
  };

  // Load the finding (and the manage capability it depends on) before the
  // form ever mounts — an invalid/fixed/dismissed finding, or a viewer
  // without manage rights, must never see an editable form that only fails
  // once submitted to the backend.
  const errorCode = findingQuery.error?.data?.code;
  const notFound = findingQuery.isError && (errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN');

  // Every state of this sheet carries one header: the title, the sheet chrome,
  // and the top clearance the formSheet route owns.
  const sheetHeader = (
    <ScreenHeader
      className="px-6"
      title={t('securityAgent.dismiss.title')}
      modal
      modalTopInset={modalTopInset}
    />
  );

  if (notFound) {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.notFoundTitle')}
          description={t('securityAgent.dismiss.notFoundDescription')}
        />
      </View>
    );
  }

  if (findingQuery.isError && !findingQuery.data) {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <QueryError
          message={t('securityAgent.dismiss.couldNotLoad')}
          onRetry={() => void findingQuery.refetch()}
        />
      </View>
    );
  }

  // A first read the online manager paused (see pausedOfflineRead): the
  // loading gate would hold the skeleton until connectivity returns. Name
  // the connection and offer Retry for each read the form waits on.
  const findingPaused = pausedOfflineRead(findingQuery);
  const capabilityPaused = pausedOfflineRead(capability);
  if (findingPaused || capabilityPaused) {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <QueryError
          variant="offline"
          message={t(
            findingPaused
              ? 'securityAgent.dismiss.couldNotLoad'
              : 'securityAgent.dismiss.couldNotCheckPermissions'
          )}
          onRetry={() => void (findingPaused ? findingQuery.refetch() : capability.refetch())}
        />
      </View>
    );
  }

  if (capability.status === 'error') {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <QueryError
          message={t('securityAgent.dismiss.couldNotCheckPermissions')}
          onRetry={() => void capability.refetch()}
        />
      </View>
    );
  }

  if (
    findingQuery.isLoading ||
    !findingQuery.data ||
    capability.isLoading ||
    !dismissDraft.hydrated
  ) {
    return <DismissFindingSkeleton />;
  }

  const finding = findingQuery.data;

  if (!capability.canManage) {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.cannotDismissDescription')}
        />
      </View>
    );
  }

  if (finding.status !== 'open') {
    return (
      <View className="flex-1 bg-background">
        {sheetHeader}
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.alreadyResolvedDescription')}
        />
      </View>
    );
  }

  const dismissFailure: DismissFailure | null = resolveDismissFailure(
    dismissFinding.isError ? dismissFinding.error : null,
    dismissDraft.draft,
    canManageBilling
  );
  // A terminal rejection ended the intent, so disable the CTA and let the
  // inline copy explain the outcome. The lapsed-trial refusal is the one where
  // the reader can end the state from here, so a reader who can change the plan
  // is offered that step under the sentence.
  const dismissBlocked = dismissFailure?.kind === 'terminal';
  // The sentence can come from the live rejection or from the draft that
  // survives the sheet, so the ledger is asked about whichever one holds it:
  // the raw error, or the key that names the copy the draft replays.
  const dismissIsTrialRefusal = dismissFinding.isError
    ? isSecurityTrialRefusal(dismissFinding.error)
    : isSecurityTrialRefusalCopyKey(dismissDraft.draft?.lastErrorKey);
  const dismissRefusalAction = dismissIsTrialRefusal ? billingAction : undefined;

  return (
    <View className="flex-1 bg-background">
      {sheetHeader}
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-6 pb-8 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        {/* The dismissal is irreversible on GitHub, so the form names its
            target the way finding-details-panel.tsx does: the title, then the
            repository, then the package. Every line wraps instead of
            truncating — a long title must stay readable to confirm the
            finding. */}
        <View className="gap-1 rounded-lg bg-secondary p-3">
          <Text className="text-base font-medium">{finding.title}</Text>
          <Text variant="muted" className="text-xs">
            {finding.repo_full_name}
          </Text>
          <Text variant="muted" className="text-xs">
            {finding.package_name} ({finding.package_ecosystem})
          </Text>
        </View>
        {findingQuery.isError ? (
          <SettingsRecoveryStatus
            message={t('securityAgent.dismiss.couldNotLoad')}
            isRetrying={findingQuery.isFetching}
            onRetry={() => void findingQuery.refetch()}
          />
        ) : null}
        {capability.isError ? (
          <SettingsRecoveryStatus
            message={t('securityAgent.dismiss.couldNotCheckPermissions')}
            isRetrying={capability.isFetching}
            onRetry={() => void capability.refetch()}
          />
        ) : null}
        <PillGroup
          label={t('securityAgent.dismiss.reason')}
          options={DISMISS_REASONS.map(option => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          value={reason}
          disabled={false}
          onChange={value => {
            setReason(value);
            persistOnType(value, commentRef.current);
          }}
        />

        <View className="gap-1.5">
          <Text className="text-sm font-medium text-muted-foreground">
            {t('securityAgent.dismiss.commentLabel')}
          </Text>
          <TextInput
            accessibilityLabel={t('securityAgent.dismiss.commentLabel')}
            className="h-24 rounded-lg bg-secondary p-3 text-sm leading-[1.25rem] text-foreground"
            multiline
            textAlignVertical="top"
            placeholder={t('securityAgent.dismiss.commentPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            defaultValue={dismissDraft.draft?.comment ?? ''}
            onChangeText={value => {
              commentRef.current = value;
              persistOnType(reason, value);
            }}
          />
        </View>

        {dismissFailure !== null &&
          (dismissRefusalAction === undefined ? (
            <Text className="text-sm text-destructive">{dismissFailure.message}</Text>
          ) : (
            <RefusalStatus
              message={dismissFailure.message}
              action={dismissRefusalAction}
              className="text-sm"
            />
          ))}

        <Button disabled={!reason || dismissFinding.isPending || dismissBlocked} onPress={onSubmit}>
          {dismissFinding.isPending ? (
            <ActivityIndicator size="small" color={mutedDisabledInk} />
          ) : null}
          <Text>{t('securityAgent.dismiss.title')}</Text>
        </Button>
      </ScrollView>
    </View>
  );
}
