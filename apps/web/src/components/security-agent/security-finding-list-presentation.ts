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

const gridWithSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';
const gridWithoutSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';

export function getFindingListGridClass(showSla: boolean) {
  return showSla ? gridWithSla : gridWithoutSla;
}

function isSupersededFinding(finding: SecurityFinding) {
  return finding.status === 'ignored' && finding.ignored_reason?.startsWith('superseded:');
}

export function getAnalysisPresentation(finding: SecurityFinding): FindingStatusPresentation {
  if (finding.analysis_status === 'pending') {
    return {
      icon: Loader2,
      label: 'Analysis queued',
      tone: 'warning',
      spinning: true,
      tooltip: 'Analysis is queued',
    };
  }
  if (finding.analysis_status === 'running') {
    return {
      icon: Loader2,
      label: 'Analyzing',
      tone: 'warning',
      spinning: true,
      tooltip: 'Analysis is running',
    };
  }
  if (finding.analysis_status === 'failed') {
    return {
      icon: XCircle,
      label: 'Analysis failed',
      tone: 'destructive',
      tooltip: finding.analysis_error || 'Analysis failed. Retry to run it again.',
    };
  }

  const sandbox = finding.analysis?.sandboxAnalysis;
  const triage = finding.analysis?.triage;
  if (sandbox?.isExploitable === true) {
    return {
      icon: ShieldAlert,
      label: 'Exploitable',
      tone: 'destructive',
      tooltip: sandbox.summary || 'Codebase analysis confirmed this vulnerability is exploitable',
    };
  }
  if (sandbox?.isExploitable === false) {
    return {
      icon: ShieldCheck,
      label: 'Not exploitable',
      tone: 'success',
      tooltip: sandbox.summary || 'Codebase analysis determined this is not exploitable',
    };
  }
  if (triage?.suggestedAction === 'dismiss') {
    return {
      icon: ShieldCheck,
      label: 'Safe to dismiss',
      tone: 'success',
      tooltip: triage.needsSandboxReasoning || 'Triage determined this can be safely dismissed',
    };
  }
  if (triage?.suggestedAction === 'manual_review') {
    return {
      icon: Eye,
      label: 'Needs review',
      tone: 'warning',
      tooltip: triage.needsSandboxReasoning || 'Triage flagged this for manual review',
    };
  }
  if (finding.analysis_status === 'completed') {
    return {
      icon: Shield,
      label: triage ? 'Triage complete' : 'Analyzed',
      tone: 'neutral',
      tooltip: triage?.needsSandboxReasoning || null,
    };
  }
  return {
    icon: Brain,
    label: 'Not analyzed',
    tone: 'neutral',
  };
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
