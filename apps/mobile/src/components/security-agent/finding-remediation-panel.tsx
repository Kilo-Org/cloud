import { ActivityIndicator, Alert, Linking, View } from 'react-native';

import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useCancelSecurityRemediation,
  useRetrySecurityRemediation,
  useStartSecurityRemediation,
} from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SecurityAnalysis } from '@/lib/security-agent';
import {
  formatRemediationOrigin,
  formatValidationEvidenceEntry,
  getRemediationStatusPresentation,
  getRemediationUnavailableCopy,
} from '@/lib/security-agent-presentation';
import { firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingRemediationPanelProps = {
  scope: string;
  findingId: string;
  analysis: SecurityAnalysis | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

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
  const startRemediation = useStartSecurityRemediation(scope);
  const retryRemediation = useRetrySecurityRemediation(scope);
  const cancelRemediation = useCancelSecurityRemediation(scope);

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
        <QueryError message="Could not load remediation status" onRetry={onRetry} />
      </View>
    );
  }

  if (!analysis) {
    return null;
  }

  const { remediationCapability, remediationSummary, remediationAttempts } = analysis;
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
          <Text className="text-primary-foreground">Start fix</Text>
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
          <Text>Retry fix</Text>
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
              'Cancel this remediation?',
              'Security Agent will stop the in-progress remediation attempt.',
              [
                { text: 'Keep running', style: 'cancel' },
                {
                  text: 'Cancel remediation',
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
          <Text>Cancel fix</Text>
        </Button>
      ) : null}

      {summaryPrUrl ? (
        <Button
          variant="outline"
          onPress={() => {
            void Linking.openURL(summaryPrUrl);
          }}
        >
          <Text>
            Open {remediationSummary.prDraft ? 'draft ' : ''}pull request
            {remediationSummary.prNumber ? ` #${remediationSummary.prNumber}` : ''}
          </Text>
        </Button>
      ) : null}

      {remediationAttempts.length > 0 ? (
        <CollapsibleSection
          title={`Attempt history (${remediationAttempts.length})`}
          defaultExpanded={remediationAttempts.length <= 2}
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
                    <Text className="text-xs font-medium">Attempt #{attempt.attemptNumber}</Text>
                    <Text variant="muted" className="text-xs">
                      {timeAgo(parseTimestamp(attempt.updatedAt))}
                    </Text>
                  </View>
                  <FindingStatusBadge
                    icon={attemptPresentation.icon}
                    label={attemptPresentation.label}
                    tone={attemptPresentation.tone}
                  />
                  <KvRow label="Started by" value={formatRemediationOrigin(attempt.origin)} />
                  <KvRow label="Model" value={attempt.remediationModelSlug} selectable />
                  <KvRow label="Branch" value={attempt.branchName} last selectable />
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
                        void Linking.openURL(attemptUrl);
                      }}
                    >
                      <Text>
                        Open pull request{attempt.prNumber ? ` #${attempt.prNumber}` : ''}
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
