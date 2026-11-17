/* eslint-disable max-lines -- this panel renders one analysis response. */
import {
  getSecurityAnalysisDetailPresentation,
  getSecurityFindingAnalysisState,
} from '@kilocode/app-shared/security-agent';
import { ExternalLink, ScanSearch } from '@/components/ui/icons';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { MarkdownText } from '@/components/agents/markdown-text';
import { CenteredState } from '@/components/centered-state';
import { TabScreenScrollView } from '@/components/tab-screen';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import {
  formatConfidence,
  formatExploitable,
  formatSuggestedAction,
  getAgentChatSessionHref,
} from '@/components/security-agent/finding-analysis-panel-helpers';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirmDialog } from '@/components/ui/dialog';
import { KvRow } from '@/components/ui/kv-row';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { AnalysisCapacityNotice } from '@/components/security-agent/analysis-capacity-notice';
import { AnalysisRerunAction } from '@/components/security-agent/analysis-rerun-action';
import { formatNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS, SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { useSecurityAnalysisCapacity } from '@/lib/hooks/use-security-agent';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useMutedDisabledInk, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { LTR_TEXT_DIRECTION } from '@/lib/rtl-text';
import { remediationNeedsAnalysisRefresh, type SecurityAnalysis } from '@/lib/security-agent';
import {
  getAnalysisCapacityBlockedHint,
  getSecurityAnalysisDetailDescription,
  getSecurityAnalysisDetailTitle,
} from '@/lib/security-agent-copy';
import { firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingAnalysisPanelProps = {
  scope: string;
  findingId: string;
  analysis: SecurityAnalysis | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

// Ported from FindingDetailDialog.tsx:985; this panel keeps the raw technical report.
export function FindingAnalysisPanel({
  scope,
  findingId,
  analysis,
  isLoading,
  isError,
  onRetry,
}: Readonly<FindingAnalysisPanelProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const mutedDisabledInk = useMutedDisabledInk();
  const { i18n, t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const capacity = useSecurityAnalysisCapacity(scope);
  const startAnalysis = useStartSecurityAnalysis(scope);
  const now = useRelativeTimeNow();

  if (isLoading && !analysis) {
    return (
      <View className={SCREEN_BODY_CLASS}>
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        {dialog}
      </View>
    );
  }

  if (isError && !analysis) {
    return (
      <>
        <QueryError message={t('securityAgent.analysis.couldNotLoad')} onRetry={onRetry} />
        {dialog}
      </>
    );
  }

  if (!analysis) {
    return (
      <>
        <EmptyState
          icon={ScanSearch}
          title={t('securityAgent.analysis.noAnalysisYet')}
          description={t('securityAgent.analysis.noAnalysisYetDescription')}
        />
        {dialog}
      </>
    );
  }

  const analysisState = getSecurityFindingAnalysisState(analysis.status, analysis.analysis);
  const presentation = getSecurityAnalysisDetailPresentation(
    analysis.status,
    analysis.analysis,
    analysis.error
  );
  const triage = analysis.analysis?.triage;
  const sandbox = analysis.analysis?.sandboxAnalysis;
  const analyzedAt = sandbox ? parseTimestamp(sandbox.analysisAt) : null;
  const analyzedLabel =
    analyzedAt === null || Number.isNaN(analyzedAt.getTime())
      ? t('securityAgent.analysis.notRecorded')
      : timeAgo(analyzedAt, undefined, now);
  const presentationTitle = getSecurityAnalysisDetailTitle(analysisState);
  const presentationDescription = getSecurityAnalysisDetailDescription(analysisState, {
    analysisError: analysis.error,
    sandboxSummary: sandbox?.summary,
    sandboxReasoning: sandbox?.exploitabilityReasoning,
    triageReasoning: triage?.needsSandboxReasoning,
  });
  const technicalMarkdown = firstNonEmpty(sandbox?.rawMarkdown, analysis.analysis?.rawMarkdown);
  // The model slug is an identifier, so its row names a left-to-right run; the
  // fallback below is copy and keeps the interface direction. Both read this
  // one value so they cannot drift apart.
  const analysisModel = firstNonEmpty(sandbox?.modelUsed, analysis.analysis?.analysisModel);
  const uniqueLocations = sandbox ? [...new Set(sandbox.usageLocations)] : [];
  const exploitabilityReasoning = sandbox
    ? firstNonEmpty(sandbox.summary, sandbox.exploitabilityReasoning)
    : '';
  const sessionHref = getAgentChatSessionHref(scope, analysis.cliSessionId);

  // Admission mirrors SecurityFindingRow.tsx's showAnalysisAction/canRestartAnalysis
  // — server owns eligibility, this just reads the already-fetched state.
  const findingOpen = analysis.findingState.status === 'open';
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
  // A completed analysis whose finding changed since offers no start or restart
  // action above, so the stale blocker would read as unfixable on this tab too.
  const needsAnalysisRefresh = remediationNeedsAnalysisRefresh(analysis);
  const hasCapacity = capacity.state === 'available';

  const handleStartAnalysis = () => {
    startAnalysis.mutate({
      findingId,
      retrySandboxOnly: analysisState === 'failed' && Boolean(triage),
    });
  };

  const handleRestartAnalysis = () => {
    confirm({
      title: t('securityAgent.analysis.restartTitle'),
      message: t('securityAgent.analysis.restartMessage'),
      confirmLabel: t('securityAgent.analysis.restartAnalysis'),
      cancelLabel: t('securityAgent.analysis.keepWaiting'),
      onConfirm: () => {
        startAnalysis.mutate({ findingId, restartActive: true });
      },
    });
  };

  const hasContent =
    (triageState && Boolean(triage)) ||
    (sandboxState && Boolean(sandbox)) ||
    Boolean(technicalMarkdown);

  const content = (
    <View className="gap-6">
      <Card>
        <FindingStatusBadge
          icon={presentation.icon}
          label={presentationTitle}
          tone={presentation.tone}
          spinning={presentation.spinning}
        />
        <Text variant="muted" className="text-sm" selectable>
          {presentationDescription}
        </Text>
      </Card>

      {canStartAnalysis || canRestartAnalysis || needsAnalysisRefresh ? (
        <View className="gap-3">
          {canStartAnalysis ? (
            <Button
              disabled={startAnalysis.isPending || !hasCapacity}
              accessibilityHint={getAnalysisCapacityBlockedHint(capacity.state)}
              onPress={handleStartAnalysis}
            >
              {startAnalysis.isPending ? (
                <ActivityIndicator size="small" color={mutedDisabledInk} />
              ) : null}
              <Text>
                {analysisState === 'failed'
                  ? t('securityAgent.analysis.retryAnalysis')
                  : t('securityAgent.analysis.analyzeRepository')}
              </Text>
            </Button>
          ) : null}
          {canStartAnalysis ? (
            <AnalysisCapacityNotice
              state={capacity.state}
              onRetry={() => void capacity.refetch()}
            />
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
          {needsAnalysisRefresh ? (
            <AnalysisRerunAction scope={scope} findingId={findingId} />
          ) : null}
        </View>
      ) : null}

      {sessionHref ? (
        <RowGroup leadingTile>
          <RowFrame
            icon={ExternalLink}
            title={t('securityAgent.analysis.watchInCloudAgent')}
            trailing={{ kind: 'chevron' }}
            accessibilityRole="link"
            onPress={() => {
              pushOnce(sessionHref);
            }}
          />
        </RowGroup>
      ) : null}

      {triageState && triage ? (
        <RowGroup>
          <KvRow
            label={t('securityAgent.analysis.triageConfidence')}
            value={formatConfidence(triage.confidence)}
            valueFace="text"
          />
          <KvRow
            label={t('securityAgent.analysis.suggestedAction')}
            value={formatSuggestedAction(triage.suggestedAction)}
            valueFace="text"
          />
        </RowGroup>
      ) : null}

      {triageState && triage?.needsSandboxReasoning ? (
        <Section label={t('securityAgent.analysis.triageReasoning')}>
          <Card>
            <Text className="text-sm" selectable>
              {triage.needsSandboxReasoning}
            </Text>
          </Card>
        </Section>
      ) : null}

      {sandboxState && sandbox ? (
        <RowGroup>
          <KvRow
            label={t('securityAgent.analysis.exploitable')}
            value={formatExploitable(sandbox.isExploitable)}
            valueFace="text"
          />
          <KvRow
            label={t('securityAgent.analysis.suggestedAction')}
            value={formatSuggestedAction(sandbox.suggestedAction)}
            valueFace="text"
          />
          <KvRow
            label={t('common.model')}
            value={firstNonEmpty(analysisModel, t('securityAgent.analysis.notRecorded'))}
            valueFace={analysisModel === '' ? 'text' : 'mono'}
            valueDirection={analysisModel === '' ? undefined : 'ltr'}
            selectable
          />
          <KvRow
            label={t('securityAgent.analysis.analyzed')}
            value={analyzedLabel}
            valueFace="text"
            selectable
          />
        </RowGroup>
      ) : null}

      {sandboxState && sandbox && exploitabilityReasoning ? (
        <Section label={t('securityAgent.analysis.exploitabilityReasoning')}>
          <Card>
            <Text className="text-sm" selectable>
              {exploitabilityReasoning}
            </Text>
          </Card>
        </Section>
      ) : null}

      {sandboxState && sandbox?.suggestedFix ? (
        <Section label={t('securityAgent.analysis.suggestedFix')}>
          <Card>
            <Text className="text-sm" selectable>
              {sandbox.suggestedFix}
            </Text>
          </Card>
        </Section>
      ) : null}

      {sandboxState && sandbox && uniqueLocations.length > 0 ? (
        <CollapsibleSection
          title={t('securityAgent.analysis.whereFound', {
            count: uniqueLocations.length,
            displayCount: formatNumber(uniqueLocations.length, i18n.language),
          })}
          defaultExpanded={uniqueLocations.length <= 2}
        >
          {uniqueLocations.map(location => (
            <Text
              key={location}
              variant="mono"
              className="text-xs"
              selectable
              style={LTR_TEXT_DIRECTION}
            >
              {location}
            </Text>
          ))}
        </CollapsibleSection>
      ) : null}

      {technicalMarkdown ? (
        <CollapsibleSection title={t('securityAgent.analysis.fullReport')}>
          <MarkdownText value={technicalMarkdown} />
        </CollapsibleSection>
      ) : null}
    </View>
  );

  return (
    <>
      {hasContent ? (
        <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
          {content}
        </TabScreenScrollView>
      ) : (
        <CenteredState contentContainerClassName={SCREEN_GUTTER_CLASS}>{content}</CenteredState>
      )}
      {dialog}
    </>
  );
}
