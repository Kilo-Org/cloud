import { useRouter } from 'expo-router';
import { ShieldOff } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSecurityAgentCapability } from '@/lib/hooks/use-security-agent';
import {
  isSecurityConfigurationError,
  isSecuritySyncRetryable,
  SECURITY_CONFIGURATION_COPY,
} from '@/lib/hooks/use-security-agent-mutations';
import { useSecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import { useDismissSecurityFinding, useSecurityFinding } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

function DismissFindingSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
      <View className="gap-6 px-6 pt-4">
        <Skeleton className="h-[224px] w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-md" />
      </View>
    </View>
  );
}

export function DismissFindingScreen({ scope, findingId }: Readonly<DismissFindingScreenProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const capability = useSecurityAgentCapability(scope);
  const findingQuery = useSecurityFinding(scope, findingId);
  const [reason, setReason] = useState<DismissReason | null>(null);
  const commentRef = useRef('');
  const dismissFinding = useDismissSecurityFinding(scope);
  const dismissDraft = useSecurityDismissDraft(scope, findingId);

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
    dismissDraft.persist({ reason, comment, lastError: null, retryable: null });
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
            lastError: isSecurityConfigurationError(error)
              ? SECURITY_CONFIGURATION_COPY
              : error.message,
            retryable: isSecuritySyncRetryable(error),
          });
        },
      }
    );
  };

  // Persist the reason and comment as the user types (debounced by the drafts
  // module), so a typed draft survives leave and reopen without a submit. The
  // existing `lastError`/`retryable` are preserved: editing an unresolved
  // failure must not clear the retry card until the user re-submits.
  const persistOnType = (nextReason: DismissReason | null, nextComment: string) => {
    const existing = dismissDraft.draft;
    dismissDraft.persist({
      reason: nextReason ?? '',
      comment: nextComment,
      lastError: existing?.lastError ?? null,
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
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
        <EmptyState
          icon={ShieldOff}
          className="flex-1"
          title={t('securityAgent.dismiss.notFoundTitle')}
          description={t('securityAgent.dismiss.notFoundDescription')}
        />
      </View>
    );
  }

  if (findingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
        <QueryError
          className="flex-1"
          message={t('securityAgent.dismiss.couldNotLoad')}
          onRetry={() => void findingQuery.refetch()}
        />
      </View>
    );
  }

  if (capability.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
        <QueryError
          className="flex-1"
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
        <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
        <EmptyState
          icon={ShieldOff}
          className="flex-1"
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.cannotDismissDescription')}
        />
      </View>
    );
  }

  if (finding.status !== 'open') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
        <EmptyState
          icon={ShieldOff}
          className="flex-1"
          title={t('securityAgent.dismiss.cannotDismissTitle')}
          description={t('securityAgent.dismiss.alreadyResolvedDescription')}
        />
      </View>
    );
  }

  // A terminal rejection ended the intent, so disable the CTA and let the
  // inline copy explain the outcome.
  const dismissBlocked = dismissFinding.isError && !isSecuritySyncRetryable(dismissFinding.error);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.dismiss.title')} modal />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pb-8 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
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

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.dismiss.commentLabel')}
          </Text>
          <TextInput
            accessibilityLabel={t('securityAgent.dismiss.commentAccessibility')}
            className="h-24 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
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

        {dismissFinding.isError && (
          <Text className="text-sm text-destructive">
            {isSecurityConfigurationError(dismissFinding.error)
              ? SECURITY_CONFIGURATION_COPY
              : dismissFinding.error.message}
          </Text>
        )}

        <Button disabled={!reason || dismissFinding.isPending || dismissBlocked} onPress={onSubmit}>
          {dismissFinding.isPending ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : null}
          <Text className="text-primary-foreground">{t('securityAgent.dismiss.submit')}</Text>
        </Button>
      </ScrollView>
    </View>
  );
}
