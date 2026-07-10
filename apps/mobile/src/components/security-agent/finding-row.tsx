import {
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink } from 'lucide-react-native';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';

import {
  FINDING_ICONS,
  FINDING_TONE_TEXT_CLASS,
  findingToneColor,
} from '@/components/security-agent/finding-tone';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath, type SecurityFinding } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

const SEVERITY_TEXT_CLASS: Record<string, string> = {
  critical: 'text-destructive',
  high: 'text-warn',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
};

function severityLabel(severity: string): string {
  return severity.length > 0 ? `${severity.charAt(0).toUpperCase()}${severity.slice(1)}` : severity;
}

// Clearest next action for this finding, mirroring the priority order in
// apps/web/src/components/security-agent/SecurityFindingRow.tsx — but as a
// read-only summary label (the list row only navigates; mutations live on
// the detail screen).
function getNextActionLabel(finding: SecurityFinding): string | null {
  const remediation = finding.remediationSummary;
  const capability = finding.remediationCapability;

  if (remediation?.status === 'pr_opened' && remediation.prUrl) {
    return 'Remediation PR open';
  }
  if (capability.canCancel) {
    return 'Remediation in progress';
  }
  if (capability.canRetry) {
    return 'Retry fix available';
  }
  if (capability.canStart) {
    return 'Fix available';
  }
  const needsAnalysis =
    finding.status === 'open' && (!finding.analysis_status || finding.analysis_status === 'failed');
  if (needsAnalysis) {
    return finding.analysis_status === 'failed' ? 'Retry analysis' : 'Run analysis';
  }
  if (finding.analysis?.triage?.suggestedAction === 'manual_review' && finding.status === 'open') {
    return 'Needs manual review';
  }
  if (finding.status === 'fixed' || finding.status === 'ignored') {
    return 'View details';
  }
  return null;
}

type FindingRowQuickActionProps = {
  finding: SecurityFinding;
  scope: string;
  prUrl: string | null;
  canQuickAnalyze: boolean;
  nextAction: string | null;
};

// Extracted to avoid a nested ternary (prUrl / canQuickAnalyze / nextAction
// fallback) while keeping FindingRow's render body flat.
function FindingRowQuickAction({
  finding,
  scope,
  prUrl,
  canQuickAnalyze,
  nextAction,
}: Readonly<FindingRowQuickActionProps>) {
  const colors = useThemeColors();
  const startAnalysis = useStartSecurityAnalysis(scope);
  const analysisFailed = finding.analysis_status === 'failed';

  if (prUrl) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="mt-1 h-8 self-start px-3"
        onPress={() => {
          void Linking.openURL(prUrl);
        }}
      >
        <ExternalLink size={13} color={colors.foreground} />
        <Text className="text-xs font-medium">View PR</Text>
      </Button>
    );
  }

  if (canQuickAnalyze) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="mt-1 h-8 self-start px-3"
        disabled={startAnalysis.isPending}
        onPress={() => {
          startAnalysis.mutate({
            findingId: finding.id,
            retrySandboxOnly: analysisFailed && Boolean(finding.analysis?.triage),
          });
        }}
      >
        {startAnalysis.isPending ? (
          <ActivityIndicator size="small" color={colors.foreground} />
        ) : null}
        <Text className="text-xs font-medium">{analysisFailed ? 'Retry analysis' : 'Analyze'}</Text>
      </Button>
    );
  }

  if (!nextAction) {
    return null;
  }

  return (
    <Text variant="muted" className="text-xs">
      {nextAction}
    </Text>
  );
}

type FindingRowProps = {
  finding: SecurityFinding;
  scope: string;
  slaEnabled: boolean;
  /** From useSecurityAnalysisCapacity(scope) — gates the row's quick Analyze action. */
  hasAnalysisCapacity: boolean;
};

export function FindingRow({
  finding,
  scope,
  slaEnabled,
  hasAnalysisCapacity,
}: Readonly<FindingRowProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  const analysis = getSecurityAnalysisPresentation(finding);
  const deadline = slaEnabled ? getSecurityDeadlinePresentation(finding) : null;
  const nextAction = getNextActionLabel(finding);

  const AnalysisIcon = FINDING_ICONS[analysis.icon];
  const DeadlineIcon = deadline ? FINDING_ICONS[deadline.icon] : null;

  const prUrl =
    finding.remediationSummary?.status === 'pr_opened' ? finding.remediationSummary.prUrl : null;
  const canQuickAnalyze =
    !prUrl &&
    finding.status === 'open' &&
    (!finding.analysis_status || finding.analysis_status === 'failed') &&
    hasAnalysisCapacity;

  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Pressable
        className="gap-1.5 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={`${severityLabel(finding.severity)} finding: ${finding.title}. ${finding.repo_full_name}. ${analysis.label}${deadline ? `. ${deadline.label}` : ''}`}
        onPress={() => {
          router.push(getSecurityAgentPath(scope, `findings/${finding.id}`));
        }}
      >
        <Text
          className={cn(
            'font-mono-medium text-[11px] uppercase tracking-[0.6px]',
            SEVERITY_TEXT_CLASS[finding.severity] ?? 'text-muted-foreground'
          )}
        >
          {severityLabel(finding.severity)}
        </Text>
        <Text className="text-sm font-medium" numberOfLines={2}>
          {finding.title}
        </Text>
        <Text variant="muted" className="text-xs" numberOfLines={1}>
          {finding.repo_full_name}
        </Text>
        <View className="flex-row flex-wrap items-center gap-3 pt-0.5">
          <View className="flex-row items-center gap-1">
            <AnalysisIcon size={13} color={findingToneColor(colors, analysis.tone)} />
            <Text className={cn('text-xs', FINDING_TONE_TEXT_CLASS[analysis.tone])}>
              {analysis.label}
            </Text>
          </View>
          {deadline && DeadlineIcon && (
            <View className="flex-row items-center gap-1">
              <DeadlineIcon size={13} color={findingToneColor(colors, deadline.tone)} />
              <Text className={cn('text-xs', FINDING_TONE_TEXT_CLASS[deadline.tone])}>
                {deadline.label}
              </Text>
            </View>
          )}
        </View>
      </Pressable>
      <FindingRowQuickAction
        finding={finding}
        scope={scope}
        prUrl={prUrl}
        canQuickAnalyze={canQuickAnalyze}
        nextAction={nextAction}
      />
    </View>
  );
}
