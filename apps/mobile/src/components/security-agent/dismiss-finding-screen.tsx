import { useRouter } from 'expo-router';
import { ShieldOff } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { DismissSheetFrame } from '@/components/security-agent/dismiss-sheet-frame';
import {
  DISMISS_REASONS,
  type DismissReason,
  isDismissReason,
} from '@/components/security-agent/dismissal-reasons';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RefusalStatus } from '@/components/refusal-status';
import { SheetHeader } from '@/components/sheet-header';
import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { DismissFindingSkeleton } from '@/components/security-agent/dismiss-finding-skeleton';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  type DismissFailure,
  isDismissFailureRetryable,
  resolveDismissFailure,
} from '@/components/security-agent/dismiss-finding-failure';
import {
  useRetrySecurityAgentCapability,
  useSecurityAgentCapability,
} from '@/lib/hooks/use-security-agent';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';
import {
  isSecurityTrialRefusal,
  isSecurityTrialRefusalCopyKey,
  securityMutationCopyKey,
} from '@/lib/security-agent-ledger';
import { useSecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import {
  useDismissSecurityFinding,
  useRetrySecurityFinding,
  useSecurityFinding,
} from '@/lib/hooks/use-security-findings';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { isReadPausedBeforeData } from '@/lib/query/read-failure-variant';
import { useBillingAction, useCanManageBilling } from '@/lib/trial-refusal';
import { cn } from '@/lib/utils';

type DismissFindingScreenProps = {
  scope: string;
  findingId: string;
};

export function DismissFindingScreen({ scope, findingId }: Readonly<DismissFindingScreenProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  // The route is a formSheet pushed over the scope dashboard, so the sheet
  // settles a status-bar inset below the window top and the header reserves no
  // clearance of its own (`useFormSheetHeaderTopInset`).
  const headerTopInset = useFormSheetHeaderTopInset();
  const capability = useSecurityAgentCapability(scope);
  const findingQuery = useSecurityFinding(scope, findingId);
  const findingRetry = useRetrySecurityFinding(scope, findingId);
  const capabilityRetry = useRetrySecurityAgentCapability(scope);
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
  const connectivity = useCommittedConnectivityStatus();

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

  if (notFound) {
    return (
      <DismissSheetFrame>
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.notFoundTitle')}
          description={t('securityAgent.dismiss.notFoundDescription')}
        />
      </DismissSheetFrame>
    );
  }

  if (findingQuery.isError && !findingQuery.data) {
    return (
      <DismissSheetFrame>
        <QueryError
          message={t('securityAgent.dismiss.couldNotLoad')}
          onRetry={() => void findingQuery.refetch()}
        />
      </DismissSheetFrame>
    );
  }

  // A paused first read never reaches the loading gate: name the connection
  // and offer Retry for whichever read the form waits on. A deliberate retry
  // above retires the paused promise a plain `refetch` would only join.
  const findingPaused = isReadPausedBeforeData({ ...findingQuery, connectivity });
  if (findingPaused || isReadPausedBeforeData({ ...capability, connectivity })) {
    return (
      <DismissSheetFrame>
        <QueryError
          variant="offline"
          message={t(
            findingPaused
              ? 'securityAgent.dismiss.couldNotLoad'
              : 'securityAgent.dismiss.couldNotCheckPermissions'
          )}
          onRetry={() => {
            void (findingPaused ? findingRetry.retry() : capabilityRetry.retry());
          }}
          isRetrying={findingPaused ? findingRetry.isRetrying : capabilityRetry.isRetrying}
        />
      </DismissSheetFrame>
    );
  }

  if (capability.status === 'error') {
    return (
      <DismissSheetFrame>
        <QueryError
          message={t('securityAgent.dismiss.couldNotCheckPermissions')}
          onRetry={() => void capability.refetch()}
        />
      </DismissSheetFrame>
    );
  }
  // `capability.isLoading` is `isPending && isFetching`, which stays false for
  // a read paused with no data — a paused capability read in the unsettled
  // window would fall through to the cannot-dismiss empty state with no
  // Retry. `status === 'loading'` is the state the hook models for exactly
  // that case (settings-overview-screen.tsx gates on it), and it makes the
  // paused branch above true for both reads.
  if (
    findingQuery.isLoading ||
    !findingQuery.data ||
    capability.status === 'loading' ||
    !dismissDraft.hydrated
  ) {
    return <DismissFindingSkeleton />;
  }

  const finding = findingQuery.data;

  if (!capability.canManage) {
    return (
      <DismissSheetFrame>
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.cannotDismissDescription')}
        />
      </DismissSheetFrame>
    );
  }

  if (finding.status !== 'open') {
    return (
      <DismissSheetFrame>
        <EmptyState
          icon={ShieldOff}
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.alreadyResolvedDescription')}
        />
      </DismissSheetFrame>
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
      <SheetHeader
        title={t('securityAgent.dismiss.title')}
        topInset={headerTopInset}
        onCancel={() => {
          router.back();
        }}
        onDone={onSubmit}
        // The commit waits for the reason the backend requires, and for a
        // terminal rejection it stays down: the inline copy explains why.
        doneDisabled={!reason || dismissBlocked}
        doneBusy={dismissFinding.isPending}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-8')}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        {/* The dismissal is irreversible on GitHub, so the form names its
            target the way finding-details-panel.tsx does: the title, then the
            repository, then the package. Every line wraps instead of
            truncating — a long title must stay readable to confirm the
            finding. */}
        <Card>
          <Text className="text-base font-medium">{finding.title}</Text>
          <Text variant="muted" className="text-xs">
            {finding.repo_full_name}
          </Text>
          <Text variant="muted" className="text-xs">
            {finding.package_name} ({finding.package_ecosystem})
          </Text>
        </Card>
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

        <FormField
          label={t('securityAgent.dismiss.commentLabel')}
          multiline
          textAlignVertical="top"
          placeholder={t('securityAgent.dismiss.commentPlaceholder')}
          defaultValue={dismissDraft.draft?.comment ?? ''}
          className="h-24 leading-[1.25rem]"
          onChangeText={value => {
            commentRef.current = value;
            persistOnType(reason, value);
          }}
        />

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
      </ScrollView>
    </View>
  );
}
