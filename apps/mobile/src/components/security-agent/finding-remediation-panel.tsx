/* eslint-disable max-lines -- the panel composes the status card, remediation controls, summary PR button, timeline, and attempt history; each is a small rendered surface that mirrors the shared remediation pattern. Splitting would re-encode the same hooks. */
import { getRemediationStatusPresentation } from '@kilocode/app-shared/security-agent';
import { Wrench } from '@/components/ui/icons';
import { useRouter } from 'expo-router';
import { type TFunction } from 'i18next';
import { ActivityIndicator, Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { resolveCodeReviewerOpenPrDestination } from '@/lib/code-reviewer-open-pr-destination';
import { openExternalUrl } from '@/lib/external-link';
import { formatNumber } from '@/lib/format';
import {
  useCancelSecurityRemediation,
  useRetrySecurityRemediation,
  useStartSecurityRemediation,
} from '@/lib/hooks/use-security-remediation';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { type SecurityAnalysis } from '@/lib/security-agent';
import { firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingRemediationPanelProps = {
  scope: string;
  findingId: string;
  analysis: SecurityAnalysis | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

// Local label map for the remediation timeline events, keyed on the audit
// action values (same labels as the web audit report ACTION_LABELS).
const REMEDIATION_TIMELINE_LABELS = {
  'security.remediation.queued': 'securityAgent.remediation.timeline.queued',
  'security.remediation.pr_opened': 'securityAgent.remediation.timeline.prOpened',
  'security.remediation.failed': 'securityAgent.remediation.timeline.failed',
  'security.remediation.blocked': 'securityAgent.remediation.timeline.blocked',
  'security.remediation.no_changes_needed': 'securityAgent.remediation.timeline.noChangesNeeded',
  'security.remediation.cancelled': 'securityAgent.remediation.timeline.cancelled',
} as const satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

// Catalog keys for the remediation status codes, mapped from
// getRemediationStatusPresentation in packages/app-shared. The status code
// plus the PR-draft flag decides the key; icon, tone, and spinning still come
// from app-shared.
const REMEDIATION_STATUS_KEYS = {
  cancellationRequested: 'securityAgent.remediationStatus.cancellationRequested',
  notStarted: 'securityAgent.remediationStatus.notStarted',
  queued: 'securityAgent.remediationStatus.queued',
  starting: 'securityAgent.remediationStatus.starting',
  inProgress: 'securityAgent.remediationStatus.inProgress',
  draftPrOpened: 'securityAgent.remediationStatus.draftPrOpened',
  prOpened: 'securityAgent.remediationStatus.prOpened',
  blocked: 'securityAgent.remediationStatus.blocked',
  failed: 'securityAgent.remediationStatus.failed',
  noChangesNeeded: 'securityAgent.remediationStatus.noChangesNeeded',
  cancelled: 'securityAgent.remediationStatus.cancelled',
} as const satisfies Record<string, string>;

function getRemediationStatusKey(
  status: string | null,
  options: { cancellationRequestedAt?: string | null; prDraft?: boolean | null } = {}
): string | null {
  if (
    options.cancellationRequestedAt &&
    (status === 'queued' || status === 'launching' || status === 'running')
  ) {
    return REMEDIATION_STATUS_KEYS.cancellationRequested;
  }
  switch (status) {
    case null: {
      return REMEDIATION_STATUS_KEYS.notStarted;
    }
    case 'queued': {
      return REMEDIATION_STATUS_KEYS.queued;
    }
    case 'launching': {
      return REMEDIATION_STATUS_KEYS.starting;
    }
    case 'running': {
      return REMEDIATION_STATUS_KEYS.inProgress;
    }
    case 'pr_opened': {
      return options.prDraft
        ? REMEDIATION_STATUS_KEYS.draftPrOpened
        : REMEDIATION_STATUS_KEYS.prOpened;
    }
    case 'blocked': {
      return REMEDIATION_STATUS_KEYS.blocked;
    }
    case 'failed': {
      return REMEDIATION_STATUS_KEYS.failed;
    }
    case 'no_changes_needed': {
      return REMEDIATION_STATUS_KEYS.noChangesNeeded;
    }
    case 'cancelled': {
      return REMEDIATION_STATUS_KEYS.cancelled;
    }
    default: {
      return null;
    }
  }
}

// Catalog keys for the remediation origin codes, mapped from
// formatRemediationOrigin in packages/app-shared.
const REMEDIATION_ORIGIN_KEYS = {
  auto_policy: 'securityAgent.remediationStatus.originAutomaticPolicy',
  bulk_existing: 'securityAgent.remediationStatus.originIncludeExistingPolicy',
  manual: 'securityAgent.remediationStatus.originManual',
} as const satisfies Record<string, string>;

// Catalog keys for the remediation-unavailable reason codes, mapped from
// REMEDIATION_UNAVAILABLE_COPY and getRemediationUnavailableCopy in
// packages/app-shared. Unknown reasons keep the generic copy; a null/eligible
// reason stays null so callers keep their existing fallback.
const REMEDIATION_UNAVAILABLE_KEYS = {
  finding_not_found: 'securityAgent.remediationUnavailable.findingNotFound',
  approval_required: 'securityAgent.remediationUnavailable.approvalRequired',
  finding_not_open: 'securityAgent.remediationUnavailable.findingNotOpen',
  repo_not_in_scope: 'securityAgent.remediationUnavailable.repoNotInScope',
  analysis_required: 'securityAgent.remediationUnavailable.analysisRequired',
  sandbox_analysis_required: 'securityAgent.remediationUnavailable.sandboxAnalysisRequired',
  stale_analysis: 'securityAgent.remediationUnavailable.staleAnalysis',
  not_exploitable: 'securityAgent.remediationUnavailable.notExploitable',
  exploitability_unknown: 'securityAgent.remediationUnavailable.exploitabilityUnknown',
  manual_review_required: 'securityAgent.remediationUnavailable.manualReviewRequired',
  monitor_required: 'securityAgent.remediationUnavailable.monitorRequired',
  triage_only: 'securityAgent.remediationUnavailable.triageOnly',
  action_not_concrete: 'securityAgent.remediationUnavailable.actionNotConcrete',
  remediation_active: 'securityAgent.remediationUnavailable.remediationActive',
  pr_already_opened: 'securityAgent.remediationUnavailable.prAlreadyOpened',
  duplicate_analysis_result: 'securityAgent.remediationUnavailable.duplicateAnalysisResult',
  retry_not_allowed: 'securityAgent.remediationUnavailable.retryNotAllowed',
  security_agent_disabled: 'securityAgent.remediationUnavailable.securityAgentDisabled',
  auto_remediation_disabled: 'securityAgent.remediationUnavailable.autoRemediationDisabled',
  include_existing_disabled: 'securityAgent.remediationUnavailable.includeExistingDisabled',
  below_threshold: 'securityAgent.remediationUnavailable.belowThreshold',
  before_enablement: 'securityAgent.remediationUnavailable.beforeEnablement',
} as const satisfies Record<string, string>;

const REMEDIATION_UNAVAILABLE_GENERIC_KEY = 'securityAgent.remediationUnavailable.generic';

function getRemediationUnavailableKey(reason: string | null | undefined): string | null {
  if (!reason || reason === 'eligible') {
    return null;
  }
  // Object.hasOwn (not `in`) so inherited keys like 'constructor' fall
  // through to the generic copy instead of leaking prototype members.
  return Object.hasOwn(REMEDIATION_UNAVAILABLE_KEYS, reason)
    ? REMEDIATION_UNAVAILABLE_KEYS[reason as keyof typeof REMEDIATION_UNAVAILABLE_KEYS]
    : REMEDIATION_UNAVAILABLE_GENERIC_KEY;
}

function getValidationRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validation evidence arrives as untyped backend JSON; trim-check before treating the value as a string.
  return typeof value === 'string' && value.trim() ? value : null;
}

// Mirrors formatValidationEvidenceEntry in packages/app-shared except the
// `Validation check N` fallback reads the catalog instead of English.
function formatValidationEvidence(
  record: Record<string, unknown>,
  index: number,
  t: TFunction
): string {
  const label =
    getValidationRecordString(record, 'name') ??
    getValidationRecordString(record, 'title') ??
    getValidationRecordString(record, 'command') ??
    getValidationRecordString(record, 'check') ??
    t('securityAgent.remediationStatus.validationCheck', { number: index + 1 });
  const result =
    getValidationRecordString(record, 'result') ??
    getValidationRecordString(record, 'status') ??
    getValidationRecordString(record, 'summary');
  return result ? `${label}: ${result}` : label;
}

// Ported from FindingDetailDialog.tsx:1849 (getRemediationPresentation) and
// remediation-unavailable-copy.ts — capability/blocker, current summary, and
// attempt history (already newest-first from the server) as plain facts.
// Start/retry/cancel buttons are driven entirely by the server-computed
// remediationCapability — no eligibility rules are re-derived here.
export function FindingRemediationPanel({
  scope,
  findingId,
  analysis,
  isLoading,
  isError,
  onRetry,
}: Readonly<FindingRemediationPanelProps>) {
  const colors = useThemeColors();
  const router = useRouter();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const startRemediation = useStartSecurityRemediation(scope);
  const retryRemediation = useRetrySecurityRemediation(scope);
  const cancelRemediation = useCancelSecurityRemediation(scope);

  const openPullRequest = (url: string) => {
    const destination = resolveCodeReviewerOpenPrDestination(url, prReviewEnabled);
    if (destination.kind === 'in-app') {
      router.push(getPrReviewPath(destination.owner, destination.repo, destination.number));
      return;
    }
    void openExternalUrl(url, { label: t('securityAgent.remediation.pullRequest') });
  };

  if (isLoading && !analysis) {
    return (
      <View className="gap-3">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </View>
    );
  }

  if (isError && !analysis) {
    return (
      <View className="items-center justify-center py-8">
        <QueryError message={t('securityAgent.remediation.couldNotLoad')} onRetry={onRetry} />
      </View>
    );
  }

  if (!analysis) {
    return (
      <EmptyState
        icon={Wrench}
        placement="top"
        title={t('securityAgent.remediation.noAnalysisTitle')}
        description={t('securityAgent.remediation.noAnalysisDescription')}
      />
    );
  }

  const { remediationCapability, remediationSummary, remediationAttempts } = analysis;
  // A separately released client can talk to an old backend that omits the new
  // `remediationTimeline` field, so the non-nullable type is not a runtime guarantee.
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  const remediationTimeline = analysis.remediationTimeline ?? [];
  const latestAttempt = remediationAttempts[0] ?? null;
  const summaryPrUrl = remediationSummary?.prUrl;
  const summaryStatusOptions = {
    cancellationRequestedAt: latestAttempt?.cancellationRequestedAt,
    prDraft: remediationSummary?.prDraft,
  };
  const presentation = getRemediationStatusPresentation(
    remediationSummary?.status ?? null,
    summaryStatusOptions
  );
  const statusLabel =
    getRemediationStatusKey(remediationSummary?.status ?? null, summaryStatusOptions) ??
    presentation.label;
  const blockerKey = !remediationCapability.canStart
    ? getRemediationUnavailableKey(remediationCapability.startReason)
    : null;
  const retryBlockerKey =
    !remediationCapability.canRetry &&
    remediationCapability.retryReason !== remediationCapability.startReason
      ? getRemediationUnavailableKey(remediationCapability.retryReason)
      : null;

  return (
    <View className="gap-4">
      <View className="gap-1 rounded-lg bg-secondary p-3">
        <FindingStatusBadge
          icon={presentation.icon}
          label={statusLabel}
          tone={presentation.tone}
          spinning={presentation.spinning}
        />
        {remediationSummary?.outcomeSummary ? (
          <Text variant="muted" className="text-sm" selectable>
            {remediationSummary.outcomeSummary}
          </Text>
        ) : null}
        {blockerKey ? (
          <Text variant="muted" className="text-xs" selectable>
            {t(blockerKey)}
          </Text>
        ) : null}
        {retryBlockerKey ? (
          <Text variant="muted" className="text-xs" selectable>
            {t(retryBlockerKey)}
          </Text>
        ) : null}
      </View>

      {remediationCapability.canStart ? (
        <Button
          disabled={startRemediation.isPending}
          onPress={() => {
            startRemediation.mutate({ findingId });
          }}
        >
          {startRemediation.isPending ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : null}
          <Text className="text-primary-foreground">{t('securityAgent.remediation.start')}</Text>
        </Button>
      ) : null}

      {remediationCapability.canRetry ? (
        <Button
          variant="outline"
          disabled={retryRemediation.isPending}
          onPress={() => {
            retryRemediation.mutate({ findingId });
          }}
        >
          {retryRemediation.isPending ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : null}
          <Text>{t('securityAgent.remediation.retry')}</Text>
        </Button>
      ) : null}

      {remediationCapability.canCancel && remediationCapability.cancelAttemptId ? (
        <Button
          variant="destructive"
          disabled={cancelRemediation.isPending}
          onPress={() => {
            const attemptId = remediationCapability.cancelAttemptId;
            if (!attemptId) {
              return;
            }
            Alert.alert(
              t('securityAgent.remediation.cancelTitle'),
              t('securityAgent.remediation.cancelMessage'),
              [
                { text: t('securityAgent.remediation.keepRunning'), style: 'cancel' },
                {
                  text: t('securityAgent.remediation.cancelRemediation'),
                  style: 'destructive',
                  onPress: () => {
                    cancelRemediation.mutate({ attemptId, findingId });
                  },
                },
              ]
            );
          }}
        >
          {cancelRemediation.isPending ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : null}
          <Text>{t('securityAgent.remediation.cancelRemediation')}</Text>
        </Button>
      ) : null}

      {summaryPrUrl ? (
        <Button
          variant="outline"
          onPress={() => {
            openPullRequest(summaryPrUrl);
          }}
        >
          <Text>
            {t(
              remediationSummary.prDraft
                ? 'securityAgent.remediation.openDraftPullRequest'
                : 'securityAgent.remediation.openPullRequest',
              { number: remediationSummary.prNumber ? ` #${remediationSummary.prNumber}` : '' }
            )}
          </Text>
        </Button>
      ) : null}

      {remediationTimeline.length > 0 ? (
        <View className="gap-1.5 rounded-lg bg-card p-3">
          <Text className="text-xs font-medium">{t('securityAgent.remediation.progress')}</Text>
          <View className="gap-1">
            {remediationTimeline.map((event, index) => {
              const labelKey = lookup(REMEDIATION_TIMELINE_LABELS, event.action);
              return (
                <View
                  key={`${event.action}-${event.occurredAt}-${index}`}
                  className="flex-row items-center justify-between"
                >
                  <Text className="text-xs">{labelKey ? t(labelKey) : event.action}</Text>
                  <Text variant="muted" className="text-xs">
                    {timeAgo(parseTimestamp(event.occurredAt))}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {remediationAttempts.length > 0 ? (
        <CollapsibleSection
          title={t('securityAgent.remediation.attemptHistory', {
            count: remediationAttempts.length,
            displayCount: formatNumber(remediationAttempts.length, i18n.language),
          })}
          defaultExpanded={remediationAttempts.length <= 2}
          // Attempt rows below are already their own card surface — a second
          // bg-secondary card wrapping them read as a card nested in a card.
          // Transparent wrapper: one visible surface per attempt, not two.
          className="bg-transparent"
        >
          <View className="gap-3">
            {remediationAttempts.map(attempt => {
              const attemptStatusOptions = {
                cancellationRequestedAt: attempt.cancellationRequestedAt,
                prDraft: attempt.prDraft,
              };
              const attemptPresentation = getRemediationStatusPresentation(
                attempt.status,
                attemptStatusOptions
              );
              const attemptStatusLabel =
                getRemediationStatusKey(attempt.status, attemptStatusOptions) ??
                attemptPresentation.label;
              const originKey = lookup(REMEDIATION_ORIGIN_KEYS, attempt.origin);
              const validation =
                attempt.validationEvidence?.map((record, index) =>
                  formatValidationEvidence(record, index, t)
                ) ?? [];
              const note = firstNonEmpty(attempt.riskNotes, attempt.draftReason);
              const outcome = firstNonEmpty(attempt.blockedReason, attempt.lastErrorRedacted);
              const attemptUrl = attempt.prUrl;

              return (
                <View key={attempt.id} className="gap-1.5 rounded-lg bg-card p-3">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs font-medium">
                      {t('securityAgent.remediation.attemptNumber', {
                        number: attempt.attemptNumber,
                      })}
                    </Text>
                    <Text variant="muted" className="text-xs">
                      {timeAgo(parseTimestamp(attempt.updatedAt))}
                    </Text>
                  </View>
                  <FindingStatusBadge
                    icon={attemptPresentation.icon}
                    label={attemptStatusLabel}
                    tone={attemptPresentation.tone}
                    spinning={attemptPresentation.spinning}
                  />
                  <KvRow
                    label={t('securityAgent.remediation.startedBy')}
                    value={originKey ? t(originKey) : attempt.origin.replaceAll('_', ' ')}
                  />
                  <KvRow
                    label={t('securityAgent.remediation.model')}
                    value={attempt.remediationModelSlug}
                    selectable
                  />
                  <KvRow
                    label={t('securityAgent.remediation.branch')}
                    value={attempt.branchName}
                    last
                    selectable
                  />
                  {outcome ? (
                    <Text variant="muted" className="text-xs" selectable>
                      {outcome}
                    </Text>
                  ) : null}
                  {validation.length > 0 ? (
                    <View className="gap-0.5">
                      {validation.map(item => (
                        <Text key={item} variant="muted" className="text-xs" selectable>
                          {item}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {note ? (
                    <Text variant="muted" className="text-xs" selectable>
                      {note}
                    </Text>
                  ) : null}
                  {attemptUrl ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => {
                        openPullRequest(attemptUrl);
                      }}
                    >
                      <Text>
                        {t('securityAgent.remediation.openPullRequest', {
                          number: attempt.prNumber ? ` #${attempt.prNumber}` : '',
                        })}
                      </Text>
                    </Button>
                  ) : null}
                </View>
              );
            })}
          </View>
        </CollapsibleSection>
      ) : null}
    </View>
  );
}
