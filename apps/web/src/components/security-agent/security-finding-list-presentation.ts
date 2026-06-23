import { differenceInCalendarDays, format, isAfter, isBefore } from 'date-fns';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { SecurityFinding } from '@kilocode/db/schema';

export type FindingTone = 'success' | 'warning' | 'destructive' | 'neutral';

export type FindingStatusPresentation = {
  label: string;
  tone: FindingTone;
  icon: LucideIcon;
  spinning?: boolean;
  tooltip?: string | null;
};

export type FindingDeadlinePresentation = FindingStatusPresentation & {
  detail: string;
};

export type FindingAnalysisState =
  | 'queued'
  | 'analyzing'
  | 'failed'
  | 'extraction-failed'
  | 'exploitable'
  | 'not-exploitable'
  | 'unknown'
  | 'safe-to-dismiss'
  | 'manual-review'
  | 'analysis-required'
  | 'completed'
  | 'not-analyzed';

const gridWithSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';
const gridWithoutSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';

export function getFindingListGridClass(showSla: boolean) {
  return showSla ? gridWithSla : gridWithoutSla;
}

function isSupersededFinding(finding: SecurityFinding) {
  return finding.status === 'ignored' && finding.ignored_reason?.startsWith('superseded:');
}

export function getFindingAnalysisState(
  analysisStatus: string | null,
  analysis: SecurityFinding['analysis']
): FindingAnalysisState {
  if (analysisStatus === 'pending') return 'queued';
  if (analysisStatus === 'running') return 'analyzing';
  if (analysisStatus === 'failed') return 'failed';

  const sandbox = analysis?.sandboxAnalysis;
  if (sandbox?.extractionStatus === 'failed') return 'extraction-failed';
  if (sandbox?.isExploitable === true) return 'exploitable';
  if (sandbox?.isExploitable === false) return 'not-exploitable';
  if (sandbox?.isExploitable === 'unknown') return 'unknown';

  const triage = analysis?.triage;
  if (triage?.suggestedAction === 'dismiss') return 'safe-to-dismiss';
  if (triage?.suggestedAction === 'manual_review') return 'manual-review';
  if (triage) return 'analysis-required';
  if (analysisStatus === 'completed') return 'completed';
  return 'not-analyzed';
}

export function getAnalysisPresentation(finding: SecurityFinding): FindingStatusPresentation {
  const analysisState = getFindingAnalysisState(finding.analysis_status, finding.analysis);
  const sandbox = finding.analysis?.sandboxAnalysis;
  const triage = finding.analysis?.triage;

  switch (analysisState) {
    case 'queued':
      return {
        icon: Loader2,
        label: 'Analysis queued',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is queued',
      };
    case 'analyzing':
      return {
        icon: Loader2,
        label: 'Analyzing',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is running',
      };
    case 'failed':
      return {
        icon: XCircle,
        label: 'Analysis failed',
        tone: 'destructive',
        tooltip: finding.analysis_error || 'Analysis failed. Retry to run it again.',
      };
    case 'extraction-failed':
      return {
        icon: Eye,
        label: 'Needs review',
        tone: 'warning',
        tooltip: 'Structured analysis result is unavailable. Review the technical report.',
      };
    case 'exploitable':
      return {
        icon: ShieldAlert,
        label: 'Exploitable',
        tone: 'destructive',
        tooltip:
          sandbox?.summary || 'Codebase analysis confirmed this vulnerability is exploitable',
      };
    case 'not-exploitable':
      return {
        icon: ShieldCheck,
        label: 'No reachable path',
        tone: 'success',
        tooltip: sandbox?.summary || 'Codebase analysis found no reachable vulnerable path',
      };
    case 'unknown':
      return {
        icon: Eye,
        label: 'Needs review',
        tone: 'warning',
        tooltip:
          sandbox?.summary ||
          sandbox?.exploitabilityReasoning ||
          'Analysis could not confirm whether the vulnerable feature is reachable',
      };
    case 'safe-to-dismiss':
      return {
        icon: ShieldCheck,
        label: 'Safe to dismiss',
        tone: 'success',
        tooltip: triage?.needsSandboxReasoning || 'Triage determined this can be safely dismissed',
      };
    case 'manual-review':
      return {
        icon: Eye,
        label: 'Needs review',
        tone: 'warning',
        tooltip: triage?.needsSandboxReasoning || 'Triage flagged this for manual review',
      };
    case 'analysis-required':
      return {
        icon: Brain,
        label: 'Analysis required',
        tone: 'warning',
        tooltip: triage?.needsSandboxReasoning || 'Codebase analysis is required',
      };
    case 'completed':
      return {
        icon: Shield,
        label: 'Analyzed',
        tone: 'neutral',
      };
    case 'not-analyzed':
      return {
        icon: Brain,
        label: 'Not analyzed',
        tone: 'neutral',
      };
  }
}

function formatFindingDate(date: Date) {
  return format(date, 'MMM d, yyyy');
}

export function getDeadlinePresentation(
  finding: SecurityFinding,
  now = new Date()
): FindingDeadlinePresentation {
  if (finding.status === 'fixed') {
    const fixedAt = finding.fixed_at ? new Date(finding.fixed_at) : null;
    const deadline = finding.sla_due_at ? new Date(finding.sla_due_at) : null;
    const fixedBeforeDeadline = fixedAt && deadline && !isAfter(fixedAt, deadline);
    return {
      icon: fixedBeforeDeadline ? CheckCircle2 : Clock3,
      label: fixedBeforeDeadline ? 'Fixed before deadline' : 'Fixed',
      detail: fixedAt ? `Fixed ${formatFindingDate(fixedAt)}` : 'Resolution recorded',
      tone: fixedBeforeDeadline ? 'success' : 'neutral',
    };
  }

  if (finding.status === 'ignored') {
    const updatedAt = new Date(finding.updated_at);
    const label = isSupersededFinding(finding) ? 'Superseded' : 'Dismissed';
    return {
      icon: Clock3,
      label,
      detail: `${label} ${formatFindingDate(updatedAt)}`,
      tone: 'neutral',
    };
  }

  if (!finding.sla_due_at) {
    return {
      icon: Clock3,
      label: 'Deadline not set',
      detail: 'No SLA deadline',
      tone: 'neutral',
    };
  }

  const deadline = new Date(finding.sla_due_at);
  const calendarDays = differenceInCalendarDays(deadline, now);
  const detail = `Due ${formatFindingDate(deadline)}`;
  if (isBefore(deadline, now)) {
    const overdueDays = Math.abs(calendarDays);
    return {
      icon: AlertTriangle,
      label:
        overdueDays === 0
          ? 'Overdue'
          : `${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue`,
      detail,
      tone: 'destructive',
    };
  }
  if (calendarDays === 0) {
    return { icon: Clock3, label: 'Due today', detail, tone: 'warning' };
  }
  if (calendarDays === 1) {
    return { icon: Clock3, label: 'Due tomorrow', detail, tone: 'warning' };
  }
  return {
    icon: Clock3,
    label: `Due in ${calendarDays} days`,
    detail,
    tone: calendarDays <= 3 ? 'warning' : 'neutral',
  };
}
