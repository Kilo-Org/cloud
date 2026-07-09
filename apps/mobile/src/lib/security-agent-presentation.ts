import { type SecurityFinding } from '@/lib/security-agent';
import { parseTimestamp } from '@/lib/utils';

// Ported from apps/web/src/components/security-agent/security-finding-list-presentation.ts.
// The web grid-class helper (getFindingListGridClass) is web-only layout CSS
// and intentionally not ported. Detail/remediation presentation is added by
// a later task extending this file.

export type FindingTone = 'success' | 'warning' | 'danger' | 'neutral';

// Icon KEYS, not React elements — finding-row.tsx maps these to
// lucide-react-native components so this module stays UI-framework-free.
export type FindingIconKey =
  | 'loader'
  | 'x-circle'
  | 'eye'
  | 'shield-alert'
  | 'shield-check'
  | 'shield'
  | 'brain'
  | 'check-circle'
  | 'clock'
  | 'alert-triangle';

export type FindingStatusPresentation = {
  label: string;
  tone: FindingTone;
  icon: FindingIconKey;
  spinning?: boolean;
  tooltip?: string | null;
};

export type FindingDeadlinePresentation = FindingStatusPresentation & { detail: string };

export type SecurityFindingAnalysisState =
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

export function getSecurityFindingAnalysisState(
  analysisStatus: string | null,
  analysis: SecurityFinding['analysis']
): SecurityFindingAnalysisState {
  if (analysisStatus === 'pending') {
    return 'queued';
  }
  if (analysisStatus === 'running') {
    return 'analyzing';
  }
  if (analysisStatus === 'failed') {
    return 'failed';
  }

  const sandbox = analysis?.sandboxAnalysis;
  if (sandbox?.extractionStatus === 'failed') {
    return 'extraction-failed';
  }
  if (sandbox?.isExploitable === true) {
    return 'exploitable';
  }
  if (sandbox?.isExploitable === false) {
    return 'not-exploitable';
  }
  if (sandbox?.isExploitable === 'unknown') {
    return 'unknown';
  }

  const triage = analysis?.triage;
  if (triage?.suggestedAction === 'dismiss') {
    return 'safe-to-dismiss';
  }
  if (triage?.suggestedAction === 'manual_review') {
    return 'manual-review';
  }
  if (triage) {
    return 'analysis-required';
  }
  if (analysisStatus === 'completed') {
    return 'completed';
  }
  return 'not-analyzed';
}

export function getSecurityAnalysisPresentation(finding: SecurityFinding): FindingStatusPresentation {
  const analysisState = getSecurityFindingAnalysisState(finding.analysis_status, finding.analysis);
  const sandbox = finding.analysis?.sandboxAnalysis;
  const triage = finding.analysis?.triage;

  switch (analysisState) {
    case 'queued': {
      return {
        icon: 'loader',
        label: 'Analysis queued',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is queued',
      };
    }
    case 'analyzing': {
      return {
        icon: 'loader',
        label: 'Analyzing',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is running',
      };
    }
    case 'failed': {
      return {
        icon: 'x-circle',
        label: 'Analysis failed',
        tone: 'danger',
        tooltip: finding.analysis_error ?? 'Analysis failed. Retry to run it again.',
      };
    }
    case 'extraction-failed': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip: 'Structured analysis result is unavailable. Review the technical report.',
      };
    }
    case 'exploitable': {
      return {
        icon: 'shield-alert',
        label: 'Exploitable',
        tone: 'danger',
        tooltip: sandbox?.summary ?? 'Codebase analysis confirmed this vulnerability is exploitable',
      };
    }
    case 'not-exploitable': {
      return {
        icon: 'shield-check',
        label: 'Unreachable',
        tone: 'success',
        tooltip: sandbox?.summary ?? 'Codebase analysis found no reachable vulnerable path',
      };
    }
    case 'unknown': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip:
          sandbox?.summary ??
          sandbox?.exploitabilityReasoning ??
          'Analysis could not confirm whether the vulnerable feature is reachable',
      };
    }
    case 'safe-to-dismiss': {
      return {
        icon: 'shield-check',
        label: 'Safe to dismiss',
        tone: 'success',
        tooltip: triage?.needsSandboxReasoning ?? 'Triage determined this can be safely dismissed',
      };
    }
    case 'manual-review': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip: triage?.needsSandboxReasoning ?? 'Triage flagged this for manual review',
      };
    }
    case 'analysis-required': {
      return {
        icon: 'brain',
        label: 'Analysis required',
        tone: 'warning',
        tooltip: triage?.needsSandboxReasoning ?? 'Codebase analysis is required',
      };
    }
    case 'completed': {
      return { icon: 'shield', label: 'Analyzed', tone: 'neutral' };
    }
    case 'not-analyzed': {
      return { icon: 'brain', label: 'Not analyzed', tone: 'neutral' };
    }
    default: {
      const exhaustiveCheck: never = analysisState;
      throw new Error(`Unhandled security finding analysis state: ${String(exhaustiveCheck)}`);
    }
  }
}

function isSupersededFinding(finding: SecurityFinding): boolean {
  return finding.status === 'ignored' && Boolean(finding.ignored_reason?.startsWith('superseded:'));
}

function formatFindingDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Calendar-day difference in the device's local timezone (matches date-fns'
// differenceInCalendarDays semantics) — no date-fns dependency needed for
// this one comparison.
function calendarDaysDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a) - startOfDay(b)) / MS_PER_DAY);
}

export function getSecurityDeadlinePresentation(
  finding: SecurityFinding,
  now = new Date()
): FindingDeadlinePresentation {
  if (finding.status === 'fixed') {
    const fixedAt = finding.fixed_at ? parseTimestamp(finding.fixed_at) : null;
    const deadline = finding.sla_due_at ? parseTimestamp(finding.sla_due_at) : null;
    const fixedBeforeDeadline = Boolean(fixedAt && deadline && fixedAt.getTime() <= deadline.getTime());
    return {
      icon: fixedBeforeDeadline ? 'check-circle' : 'clock',
      label: fixedBeforeDeadline ? 'Fixed before deadline' : 'Fixed',
      detail: fixedAt ? `Fixed ${formatFindingDate(fixedAt)}` : 'Resolution recorded',
      tone: fixedBeforeDeadline ? 'success' : 'neutral',
    };
  }

  if (finding.status === 'ignored') {
    const updatedAt = parseTimestamp(finding.updated_at);
    const label = isSupersededFinding(finding) ? 'Superseded' : 'Dismissed';
    return {
      icon: 'clock',
      label,
      detail: `${label} ${formatFindingDate(updatedAt)}`,
      tone: 'neutral',
    };
  }

  if (!finding.sla_due_at) {
    return {
      icon: 'clock',
      label: 'Deadline not set',
      detail: 'No SLA deadline',
      tone: 'neutral',
    };
  }

  const deadline = parseTimestamp(finding.sla_due_at);
  const calendarDays = calendarDaysDiff(deadline, now);
  const detail = `Due ${formatFindingDate(deadline)}`;
  if (deadline.getTime() < now.getTime()) {
    const overdueDays = Math.abs(calendarDays);
    return {
      icon: 'alert-triangle',
      label: overdueDays === 0 ? 'Overdue' : `${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue`,
      detail,
      tone: 'danger',
    };
  }
  if (calendarDays === 0) {
    return { icon: 'clock', label: 'Due today', detail, tone: 'warning' };
  }
  if (calendarDays === 1) {
    return { icon: 'clock', label: 'Due tomorrow', detail, tone: 'warning' };
  }
  return {
    icon: 'clock',
    label: `Due in ${calendarDays} days`,
    detail,
    tone: calendarDays <= 3 ? 'warning' : 'neutral',
  };
}
