/* eslint-disable max-lines -- the panel composes the status card, remediation controls, summary PR button, timeline, and attempt history; each is a small rendered surface that mirrors the shared remediation pattern. Splitting would re-encode the same hooks. */
import {
  formatRemediationOrigin,
  formatValidationEvidenceEntry,
  getRemediationStatusPresentation,
  getRemediationUnavailableCopy,
} from '@kilocode/app-shared/security-agent';
import { Wrench } from '@/components/ui/icons';
import { useRouter } from 'expo-router';
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
  const presentation = getRemediationStatusPresentation(remediationSummary?.status ?? null, {
    cancellationRequestedAt: latestAttempt?.cancellationRequestedAt,
    prDraft: remediationSummary?.prDraft,
  });
  const blockerCopy = !remediationCapability.canStart
    ? getRemediationUnavailableCopy(remediationCapability.startReason)
    : null;
  const retryBlockerCopy =
    !remediationCapability.canRetry &&
    remediationCapability.retryReason !== remediationCapability.startReason
      ? getRemediationUnavailableCopy(remediationCapability.retryReason)
      : null;

  return (
    <View className="gap-4">
      <View className="gap-1 rounded-lg bg-secondary p-3">
        <FindingStatusBadge
          icon={presentation.icon}
          label={presentation.label}
          tone={presentation.tone}
          spinning={presentation.spinning}
        />
        {remediationSummary?.outcomeSummary ? (
          <Text variant="muted" className="text-sm" selectable>
            {remediationSummary.outcomeSummary}
          </Text>
        ) : null}
        {blockerCopy ? (
          <Text variant="muted" className="text-xs" selectable>
            {blockerCopy}
          </Text>
        ) : null}
        {retryBlockerCopy ? (
          <Text variant="muted" className="text-xs" selectable>
            {retryBlockerCopy}
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
              const attemptPresentation = getRemediationStatusPresentation(attempt.status, {
                cancellationRequestedAt: attempt.cancellationRequestedAt,
                prDraft: attempt.prDraft,
              });
              const validation =
                attempt.validationEvidence?.map(formatValidationEvidenceEntry) ?? [];
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
                    label={attemptPresentation.label}
                    tone={attemptPresentation.tone}
                    spinning={attemptPresentation.spinning}
                  />
                  <KvRow
                    label={t('securityAgent.remediation.startedBy')}
                    value={formatRemediationOrigin(attempt.origin)}
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
