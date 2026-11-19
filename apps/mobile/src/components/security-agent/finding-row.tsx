import {
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
  getSecurityFindingAnalysisState,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FINDING_ICONS } from '@/components/security-agent/finding-tone';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { RowChevron } from '@/components/ui/row-chevron';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useStartSecurityAnalysis } from '@/lib/hooks/use-security-findings';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getSecurityAgentPath,
  isSecurityFindingAnalyzable,
  type SecurityFinding,
} from '@/lib/security-agent';
import {
  getAnalysisCapacityBlockedHint,
  getDeadlineCopy,
  getSecurityAnalysisLabel,
} from '@/lib/security-agent-copy';
import { openFindingLink } from '@/lib/security-agent-link';
import { type SecurityAnalysisCapacityState } from '@/lib/security-analysis-capacity';
import { cn } from '@/lib/utils';

/**
 * A finding is a flat list row (`apps/mobile/AGENTS.md`, "Flat list rows"):
 * full-bleed, content from the 14pt gutter, a 0.5pt hairline under every row
 * but the last, and the disclosure mark at the row's trailing edge. It is the
 * one row the primitives cannot express — a severity eyebrow, a two-line title,
 * a repository caption, a state line and its own inline action — so it keeps
 * the contract's geometry rather than a card of its own.
 */
const FINDING_ROW_CLASS = 'gap-1 px-4 py-3 border-b-[0.5px] border-hair-soft';

const SEVERITY_KEYS = {
  critical: 'common.critical',
  high: 'securityAgent.sla.high',
  medium: 'securityAgent.sla.medium',
  low: 'securityAgent.sla.low',
} satisfies Record<string, string>;

const SEVERITY_TEXT_CLASS = {
  critical: 'text-destructive',
  high: 'text-warn',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

// Clearest next action for this finding, mirroring the priority order in
// apps/web/src/components/security-agent/SecurityFindingRow.tsx — but as a
// read-only summary label (the list row only navigates; mutations live on
// the detail screen).
function getNextActionLabel(finding: SecurityFinding): string | null {
  const remediation = finding.remediationSummary;
  const capability = finding.remediationCapability;

  if (remediation?.status === 'pr_opened' && remediation.prUrl) {
    return i18n.t('securityAgent.findingRow.nextRemediationPrOpen');
  }
  if (capability.canCancel) {
    return i18n.t('securityAgent.findingRow.nextRemediationInProgress');
  }
  if (capability.canRetry) {
    return i18n.t('securityAgent.findingRow.nextRetryRemediation');
  }
  if (capability.canStart) {
    return i18n.t('securityAgent.findingRow.nextRemediationAvailable');
  }
  const needsAnalysis =
    finding.status === 'open' && (!finding.analysis_status || finding.analysis_status === 'failed');
  if (needsAnalysis) {
    return finding.analysis_status === 'failed'
      ? i18n.t('securityAgent.analysis.retryAnalysis')
      : i18n.t('securityAgent.findingRow.runAnalysis');
  }
  if (finding.analysis?.triage?.suggestedAction === 'manual_review' && finding.status === 'open') {
    return i18n.t('securityAgent.analysisState.manualReviewTitle');
  }
  if (finding.status === 'fixed' || finding.status === 'ignored') {
    return i18n.t('securityAgent.findingRow.nextViewDetails');
  }
  return null;
}

type FindingRowQuickActionProps = {
  finding: SecurityFinding;
  scope: string;
  prUrl: string | null;
  isAnalyzable: boolean;
  capacityState: SecurityAnalysisCapacityState;
  nextAction: string | null;
};

// Extracted to avoid a nested ternary (prUrl / isAnalyzable / nextAction
// fallback) while keeping FindingRow's render body flat. `isAnalyzable`
// (eligibility) and `capacityState` are separate so the button's presence never
// depends on capacity still loading — only its state does, avoiding a
// button/text layout shift once capacity resolves.
//
// Both actions are `outline`, not `secondary`: the row they sit on is itself
// `bg-secondary`, so a secondary action painted the card's own fill and, with
// the shadow invisible on the dark card, read as plain text instead of a
// control. `outline` is the app's control-on-a-card surface — a `bg-card` chip
// in light and the `dark:border-neutral-700` hairline in dark.
function FindingRowQuickAction({
  finding,
  scope,
  prUrl,
  isAnalyzable,
  capacityState,
  nextAction,
}: Readonly<FindingRowQuickActionProps>) {
  const colors = useThemeColors();
  const router = useRouter();
  const { t } = useTranslation();
  const startAnalysis = useStartSecurityAnalysis(scope);
  const analysisFailed = finding.analysis_status === 'failed';

  if (prUrl) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="mt-1 self-start px-3"
        onPress={() => {
          openFindingLink(router, prUrl, t('common.pullRequest'));
        }}
      >
        <ExternalLink size={13} color={colors.foreground} />
        <Text className="text-xs font-medium">{t('securityAgent.findingRow.viewPr')}</Text>
      </Button>
    );
  }

  if (isAnalyzable) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="mt-1 self-start px-3"
        // Loading covers both the in-flight start and the capacity read, so the
        // control never looks idle while the action cannot run yet.
        loading={startAnalysis.isPending || capacityState === 'loading'}
        disabled={capacityState !== 'available'}
        accessibilityHint={getAnalysisCapacityBlockedHint(capacityState)}
        onPress={() => {
          startAnalysis.mutate({
            findingId: finding.id,
            retrySandboxOnly: analysisFailed && Boolean(finding.analysis?.triage),
          });
        }}
      >
        <Text className="text-xs font-medium">
          {analysisFailed
            ? t('securityAgent.analysis.retryAnalysis')
            : t('securityAgent.findingRow.analyze')}
        </Text>
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
  /** From useSecurityAnalysisCapacity(scope) — disables (not hides) the row's quick Analyze action. */
  capacityState: SecurityAnalysisCapacityState;
  /** Last row of the list, which drops the hairline under it. */
  last?: boolean;
};

export function FindingRow({
  finding,
  scope,
  slaEnabled,
  capacityState,
  last = false,
}: Readonly<FindingRowProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();

  const analysis = getSecurityAnalysisPresentation(finding);
  const analysisState = getSecurityFindingAnalysisState(finding.analysis_status, finding.analysis);
  const analysisLabel = getSecurityAnalysisLabel(analysisState);
  const deadline = slaEnabled ? getSecurityDeadlinePresentation(finding) : null;
  const deadlineLabel = deadline ? getDeadlineCopy(deadline.state).label : '';
  const nextAction = getNextActionLabel(finding);
  const severityKey = lookup(SEVERITY_KEYS, finding.severity);
  const severityLabel = severityKey ? t(severityKey) : finding.severity;

  const AnalysisIcon = FINDING_ICONS[analysis.icon];
  const DeadlineIcon = deadline ? FINDING_ICONS[deadline.icon] : null;

  const prUrl =
    finding.remediationSummary?.status === 'pr_opened' ? finding.remediationSummary.prUrl : null;
  // Eligibility is independent of capacity — the button stays visible
  // (disabled via capacityState) instead of swapping for the nextAction text
  // once capacity resolves.
  const isAnalyzable = isSecurityFindingAnalyzable(finding);

  const accessibilityLabel = deadline
    ? t('securityAgent.findingRow.a11yWithDeadline', {
        severity: severityLabel,
        title: finding.title,
        repo: finding.repo_full_name,
        analysis: analysisLabel,
        deadline: deadlineLabel,
      })
    : t('securityAgent.findingRow.a11y', {
        severity: severityLabel,
        title: finding.title,
        repo: finding.repo_full_name,
        analysis: analysisLabel,
      });

  return (
    <View className={cn(FINDING_ROW_CLASS, last && 'border-b-0')}>
      <Pressable
        // The row is one block, so its disclosure mark centres on the row's
        // height instead of sitting level with the severity eyebrow: every
        // other chevron in the app is centred in the row it ends.
        className="flex-row items-center gap-3 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => {
          pushOnce(getSecurityAgentPath(scope, `findings/${finding.id}`));
        }}
      >
        <View className="min-w-0 flex-1 gap-1">
          <Eyebrow className={lookup(SEVERITY_TEXT_CLASS, finding.severity) ?? undefined}>
            {severityLabel}
          </Eyebrow>
          <Text className="text-sm font-medium" numberOfLines={2}>
            {finding.title}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {finding.repo_full_name}
          </Text>
          <View className="flex-row flex-wrap items-center gap-3 pt-0.5">
            {/* One saturated colour per row: the severity eyebrow owns it, so
                the state line reads in the muted ink with its own icon. Three
                coloured tokens on one row (severity, analysis state, deadline)
                competed for the same glance and none of them won. */}
            <View className="flex-row items-center gap-1">
              <SpinningIcon
                icon={AnalysisIcon}
                size={13}
                color={colors.mutedForeground}
                spinning={Boolean(analysis.spinning)}
              />
              <Text className="text-xs text-muted-foreground">{analysisLabel}</Text>
            </View>
            {deadline && DeadlineIcon && (
              <View className="flex-row items-center gap-1">
                <SpinningIcon
                  icon={DeadlineIcon}
                  size={13}
                  color={colors.mutedForeground}
                  spinning={Boolean(deadline.spinning)}
                />
                <Text className="text-xs text-muted-foreground">{deadlineLabel}</Text>
              </View>
            )}
          </View>
        </View>
        <RowChevron />
      </Pressable>
      {/* The quick action sits beside the row's control, never inside it: a
          nested button is unreachable for assistive technology and a disabled
          Analyze would otherwise fall through to the row's own press. */}
      <FindingRowQuickAction
        finding={finding}
        scope={scope}
        prUrl={prUrl}
        isAnalyzable={isAnalyzable}
        capacityState={capacityState}
        nextAction={nextAction}
      />
    </View>
  );
}
