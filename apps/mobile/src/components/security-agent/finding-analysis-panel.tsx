import { type Href, useRouter } from 'expo-router';
import { ExternalLink } from 'lucide-react-native';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSecurityAnalysisCapacity } from '@/lib/hooks/use-security-agent';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isPersonalSecurityScope, type SecurityAnalysis } from '@/lib/security-agent';
import {
  getSecurityAnalysisDetailPresentation,
  getSecurityFindingAnalysisState,
} from '@/lib/security-agent-presentation';
import { firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingAnalysisPanelProps = {
  scope: string;
  findingId: string;
  analysis: SecurityAnalysis | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

function getAgentChatSessionHref(scope: string, cliSessionId: string | null): Href | null {
  if (!cliSessionId) {
    return null;
  }
  const path = `/(app)/agent-chat/${cliSessionId}`;
  return (isPersonalSecurityScope(scope) ? path : `${path}?organizationId=${scope}`) as Href;
}

function formatExploitable(isExploitable: boolean | 'unknown'): string {
  if (isExploitable === 'unknown') {
    return 'Unknown';
  }
  return isExploitable ? 'Yes' : 'No';
}

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
        <QueryError message="Could not load analysis" onRetry={onRetry} />
      </View>
    );
  }

  if (!analysis) {
    return null;
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
  const canStartAnalysis =
    findingOpen && (analysisState === 'not-analyzed' || analysisState === 'failed');
  const canRestartAnalysis = findingOpen && analysis.status === 'running';
  const hasCapacity =
    capacity.runningCount !== undefined &&
    capacity.concurrencyLimit !== undefined &&
    capacity.runningCount < capacity.concurrencyLimit;

  const handleStartAnalysis = () => {
    startAnalysis.mutate({
      findingId,
      retrySandboxOnly: analysisState === 'failed' && Boolean(triage),
    });
  };

  const handleRestartAnalysis = () => {
    Alert.alert(
      'Restart this analysis?',
      'Security Agent will stop waiting for the current run and queue a new analysis. Any result that arrives from the current run will be ignored.',
      [
        { text: 'Keep waiting', style: 'cancel' },
        {
          text: 'Restart analysis',
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
                {analysisState === 'failed' ? 'Retry analysis' : 'Analyze repository'}
              </Text>
            </Button>
          ) : null}
          {canStartAnalysis && !hasCapacity ? (
            <Text variant="muted" className="text-xs">
              Analysis capacity is full. Wait for an active analysis to finish.
            </Text>
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
              <Text>Restart analysis</Text>
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
          <Text className="text-sm font-medium">Watch in Cloud Agent</Text>
        </Pressable>
      ) : null}

      {triage ? (
        <View className="gap-2">
          <View className="rounded-lg bg-secondary px-3">
            <KvRow label="Triage confidence" value={humanize(triage.confidence)} />
            <KvRow label="Suggested action" value={humanize(triage.suggestedAction)} last />
          </View>
          {triage.needsSandboxReasoning ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                Triage reasoning
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {triage.needsSandboxReasoning}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {sandbox ? (
        <View className="gap-2">
          <View className="rounded-lg bg-secondary px-3">
            <KvRow label="Exploitable" value={formatExploitable(sandbox.isExploitable)} />
            <KvRow label="Suggested action" value={humanize(sandbox.suggestedAction)} />
            <KvRow
              label="Model"
              value={firstNonEmpty(
                sandbox.modelUsed,
                analysis.analysis?.analysisModel,
                'Not recorded'
              )}
              selectable
            />
            <KvRow
              label="Analyzed"
              value={timeAgo(parseTimestamp(sandbox.analysisAt))}
              last
              selectable
            />
          </View>
          {exploitabilityReasoning ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                Exploitability reasoning
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {exploitabilityReasoning}
              </Text>
            </View>
          ) : null}
          {sandbox.suggestedFix ? (
            <View className="rounded-lg bg-secondary p-3">
              <Text variant="muted" className="text-xs uppercase tracking-wide">
                Suggested fix
              </Text>
              <Text className="mt-1 text-sm" selectable>
                {sandbox.suggestedFix}
              </Text>
            </View>
          ) : null}
          {uniqueLocations.length > 0 ? (
            <CollapsibleSection
              title={`Where this was found (${uniqueLocations.length})`}
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
        <CollapsibleSection title="Full generated report">
          <MarkdownText value={technicalMarkdown} />
        </CollapsibleSection>
      ) : null}
    </View>
  );
}
