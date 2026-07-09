import { useRouter } from 'expo-router';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  type LucideIcon,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath, type SecurityFinding } from '@/lib/security-agent';
import {
  type FindingIconKey,
  type FindingTone,
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
} from '@/lib/security-agent-presentation';
import { cn } from '@/lib/utils';

const ICONS: Record<FindingIconKey, LucideIcon> = {
  loader: Loader2,
  'x-circle': XCircle,
  eye: Eye,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  shield: Shield,
  brain: Brain,
  'check-circle': CheckCircle2,
  clock: Clock3,
  'alert-triangle': AlertTriangle,
};

const TONE_TEXT_CLASS: Record<FindingTone, string> = {
  success: 'text-good',
  warning: 'text-warn',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
};

function toneColor(colors: ThemeColors, tone: FindingTone): string {
  switch (tone) {
    case 'success': {
      return colors.good;
    }
    case 'warning': {
      return colors.warn;
    }
    case 'danger': {
      return colors.destructive;
    }
    case 'neutral': {
      return colors.mutedForeground;
    }
    default: {
      const exhaustiveCheck: never = tone;
      throw new Error(`Unhandled finding tone: ${String(exhaustiveCheck)}`);
    }
  }
}

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

type FindingRowProps = {
  finding: SecurityFinding;
  scope: string;
  slaEnabled: boolean;
};

export function FindingRow({ finding, scope, slaEnabled }: Readonly<FindingRowProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  const analysis = getSecurityAnalysisPresentation(finding);
  const deadline = slaEnabled ? getSecurityDeadlinePresentation(finding) : null;
  const nextAction = getNextActionLabel(finding);

  const AnalysisIcon = ICONS[analysis.icon];
  const DeadlineIcon = deadline ? ICONS[deadline.icon] : null;

  return (
    <Pressable
      className="gap-1.5 rounded-lg bg-secondary p-3 active:opacity-70"
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
          <AnalysisIcon size={13} color={toneColor(colors, analysis.tone)} />
          <Text className={cn('text-xs', TONE_TEXT_CLASS[analysis.tone])}>{analysis.label}</Text>
        </View>
        {deadline && DeadlineIcon && (
          <View className="flex-row items-center gap-1">
            <DeadlineIcon size={13} color={toneColor(colors, deadline.tone)} />
            <Text className={cn('text-xs', TONE_TEXT_CLASS[deadline.tone])}>{deadline.label}</Text>
          </View>
        )}
      </View>
      {nextAction && (
        <Text variant="muted" className="text-xs">
          {nextAction}
        </Text>
      )}
    </Pressable>
  );
}
