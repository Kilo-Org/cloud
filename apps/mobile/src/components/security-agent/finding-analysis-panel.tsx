import {
  getSecurityAnalysisDetailPresentation,
  getSecurityFindingAnalysisState,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink, ScanSearch } from '@/components/ui/icons';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { MarkdownText } from '@/components/agents/markdown-text';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import {
  formatExploitable,
  getAgentChatSessionHref,
  humanize,
} from '@/components/security-agent/finding-analysis-panel-helpers';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSecurityAnalysisCapacity } from '@/lib/hooks/use-security-agent';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SecurityAnalysis } from '@/lib/security-agent';
import { firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingAnalysisPanelProps = {
  scope: string;
  findingId: string;
  analysis: SecurityAnalysis | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

// Ported from FindingDetailDialog.tsx:985 (getAnalysisPresentation) — triage
// and sandbox evidence rendered as plain facts plus the raw technical
// report, rather than the web's hero/summary/action/steps narrative.
export function FindingAnalysisPanel({
  scope,
  findingId,
  analysis,
  isLoading,
  isError,
  onRetry,
}: Readonly<FindingAnalysisPanelProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const capacity = useSecurityAnalysisCapacity(scope);
  const startAnalysis = useStartSecurityAnalysis(scope);

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
        <QueryError message={t('securityAgent.analysis.couldNotLoad')} onRetry={onRetry} />
      </View>
    );
  }

  if (!analysis) {
    return (
      <EmptyState
        icon={ScanSearch}
        placement="top"
        title={t('securityAgent.analysis.noAnalysisYet')}
        description={t('securityAgent.analysis.noAnalysisYetDescription')}
      />
    );
  }

  const presentation = getSecurityAnalysisDetailPresentation(
    analysis.status,
    analysis.analysis,
    analysis.error
  );
  const triage = analysis.analysis?.triage;
  const sandbox = analysis.analysis?.sandboxAnalysis;
  const technicalMarkdown = firstNonEmpty(sandbox?.rawMarkdown, analysis.analysis?.rawMarkdown);
  const uniqueLocations = sandbox ? [...new Set(sandbox.usageLocations)] : [];
  const exploitabilityReasoning = sandbox
    ? firstNonEmpty(sandbox.summary, sandbox.exploitabilityReasoning)
    : '';
  const sessionHref = getAgentChatSessionHref(scope, analysis.cliSessionId);

  // Admission mirrors SecurityFindingRow.tsx's showAnalysisAction/canRestartAnalysis
  // — server owns eligibility, this just reads the already-fetched state.
  const findingOpen = analysis.findingState.status === 'open';
  const analysisState = getSecurityFindingAnalysisState(analysis.status, analysis.analysis);
  // Sandbox/triage evidence is authoritative only once the analysis reached a
  // terminal sandbox/triage state. A stale result left behind by a failed
  // retry must not read as "Analyzed" (completion copy) in queued/running/failed.
  const sandboxState =
    analysisState === 'extraction-failed' ||
    analysisState === 'exploitable' ||
    analysisState === 'not-exploitable' ||
    analysisState === 'unknown';
  const triageState =
    analysisState === 'safe-to-dismiss' ||
    analysisState === 'manual-review' ||
    analysisState === 'analysis-required';
  const canStartAnalysis =
    findingOpen && (analysisState === 'not-analyzed' || analysisState === 'failed');
  const canRestartAnalysis = findingOpen && analysis.status === 'running';
  const hasCapacity =
    capacity.runningCount !== undefined &&
    capacity.concurrencyLimit !== undefined &&
    capacity.runningCount < capacity.concurrencyLimit;
  // "Capacity full" is only ever true after a successful count — while
  // loading or on error, `hasCapacity` is false too (so the button stays
  // disabled), but neither of those states means it's actually full.
  const capacityConfirmedFull = !capacity.isLoading && !capacity.isError && !hasCapacity;

  const handleStartAnalysis = () => {
    startAnalysis.mutate({
      findingId,
      retrySandboxOnly: analysisState === 'failed' && Boolean(triage),
    });
  };

  const handleRestartAnalysis = () => {
    Alert.alert(
      t('securityAgent.analysis.restartTitle'),
      t('securityAgent.analysis.restartMessage'),
      [
        { text: t('securityAgent.analysis.keepWaiting'), style: 'cancel' },
        {
          text: t('securityAgent.analysis.restartAnalysis'),
          style: 'destructive',
          onPress: () => {
            startAnalysis.mutate({ findingId, restartActive: true });
          },
        },
      ]
    );
  };

  return (
    <View className="gap-4">
      <View className="gap-1 rounded-lg bg-secondary p-3">
        <FindingStatusBadge
          icon={presentation.icon}
          label={presentation.title}
          tone={presentation.tone}
          spinning={presentation.spinning}
        />
        <Text variant="muted" className="text-sm" selectable>
          {presentation.description}
        </Text>
      </View>

      {canStartAnalysis || canRestartAnalysis ? (
        <View className="gap-2">
          {canStartAnalysis ? (
            <Button
              disabled={startAnalysis.isPending || !hasCapacity}
              onPress={handleStartAnalysis}
            >
              {startAnalysis.isPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text className="text-primary-foreground">
                {analysisState === 'failed'
                  ? t('securityAgent.analysis.retryAnalysis')
                  : t('securityAgent.analysis.analyzeRepository')}
              </Text>
            </Button>
          ) : null}
          {canStartAnalysis && capacityConfirmedFull ? (
            <Text variant="muted" className="text-xs">
              {t('securityAgent.analysis.capacityFull')}
            </Text>
          ) : null}
          {canStartAnalysis && capacity.isError ? (
            <View className="flex-row items-center gap-2">
              <Text variant="muted" className="text-xs">
                {t('securityAgent.analysis.couldNotCheckCapacity')}
              </Text>
              <Pressable
                onPress={() => void capacity.refetch()}
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
              >
                <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
              </Pressable>
            </View>
          ) : null}
          {canRestartAnalysis ? (
            <Button
              variant="outline"
              disabled={startAnalysis.isPending}
              onPress={handleRestartAnalysis}
            >
              {startAnalysis.isPending ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : null}
              <Text>{t('securityAgent.analysis.restartAnalysis')}</Text>
            </Button>
          ) : null}
        </View>
      ) : null}

      {sessionHref ? (
        <Pressable
          className="flex-row items-center justify-center gap-2 rounded-lg bg-secondary p-3 active:opacity-70"
          onPress={() => {
            router.push(sessionHref);
          }}
        >
          <ExternalLink size={14} color={colors.mutedForeground} />
          <Text className="text-sm font-medium">
            {t('securityAgent.analysis.watchInCloudAgent')}
          </Text>
        </Pressable>
      ) : null}

      {triageState && triage ? (
        <View className="gap-2">
          <View className="rounded-lg bg-secondary px-3">
            <KvRow
              label={t('securityAgent.analysis.triageConfidence')}
              value={humanize(triage.confidence)}
            />
            <KvRow
              label={t('securityAgent.analysis.suggestedAction')}
              value={humanize(triage.suggestedAction)}
              last
            />
          </View>
          {triage.needsSandboxReasoning ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                {t('securityAgent.analysis.triageReasoning')}
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {triage.needsSandboxReasoning}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {sandboxState && sandbox ? (
        <View className="gap-2">
          <View className="rounded-lg bg-secondary px-3">
            <KvRow
              label={t('securityAgent.analysis.exploitable')}
              value={formatExploitable(sandbox.isExploitable)}
            />
            <KvRow
              label={t('securityAgent.analysis.suggestedAction')}
              value={humanize(sandbox.suggestedAction)}
            />
            <KvRow
              label={t('securityAgent.analysis.model')}
              value={firstNonEmpty(
                sandbox.modelUsed,
                analysis.analysis?.analysisModel,
                t('securityAgent.analysis.notRecorded')
              )}
              selectable
            />
            <KvRow
              label={t('securityAgent.analysis.analyzed')}
              value={timeAgo(parseTimestamp(sandbox.analysisAt))}
              last
              selectable
            />
          </View>
          {exploitabilityReasoning ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                {t('securityAgent.analysis.exploitabilityReasoning')}
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {exploitabilityReasoning}
              </Text>
            </View>
          ) : null}
          {sandbox.suggestedFix ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                {t('securityAgent.analysis.suggestedFix')}
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {sandbox.suggestedFix}
              </Text>
            </View>
          ) : null}
          {uniqueLocations.length > 0 ? (
            <CollapsibleSection
              title={t('securityAgent.analysis.whereFound', { count: uniqueLocations.length })}
              defaultExpanded={uniqueLocations.length <= 2}
            >
              {uniqueLocations.map(location => (
                <Text key={location} variant="mono" className="text-xs" selectable>
                  {location}
                </Text>
              ))}
            </CollapsibleSection>
          ) : null}
        </View>
      ) : null}

      {technicalMarkdown ? (
        <CollapsibleSection title={t('securityAgent.analysis.fullReport')}>
          <MarkdownText value={technicalMarkdown} />
        </CollapsibleSection>
      ) : null}
    </View>
  );
}
