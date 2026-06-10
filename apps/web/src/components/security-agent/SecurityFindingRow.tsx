'use client';

import { differenceInDays, differenceInHours, differenceInMinutes, isPast } from 'date-fns';
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Eye,
  Loader2,
  Package,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SecurityFinding } from '@kilocode/db/schema';
import { cn } from '@/lib/utils';
import { SeverityBadge } from './SeverityBadge';
import { manualAnalysisAdmissionCopy } from './manual-analysis-admission-copy';

type Outcome = {
  icon: typeof CheckCircle2;
  label: string;
  className: string;
  spin: boolean;
  tooltip: string | null;
};

function getOutcome(finding: SecurityFinding): Outcome | null {
  if (finding.status === 'fixed') {
    return {
      icon: CheckCircle2,
      label: 'Fixed',
      className: 'text-green-400',
      spin: false,
      tooltip: finding.fixed_at
        ? `Fixed ${formatCompactDistance(new Date(finding.fixed_at))} ago`
        : null,
    };
  }
  if (finding.status === 'ignored') {
    return {
      icon: XCircle,
      label: 'Dismissed',
      className: 'text-muted-foreground',
      spin: false,
      tooltip: finding.ignored_reason?.replace(/_/g, ' ') ?? null,
    };
  }
  if (finding.analysis_status === 'pending' || finding.analysis_status === 'running') {
    return {
      icon: Loader2,
      label: 'Analyzing',
      className: 'text-yellow-400',
      spin: true,
      tooltip: finding.analysis_status === 'pending' ? 'Analysis is queued' : 'Analysis is running',
    };
  }
  if (finding.analysis_status === 'failed') {
    return {
      icon: XCircle,
      label: 'Analysis failed',
      className: 'text-red-400',
      spin: false,
      tooltip: finding.analysis_error || 'Analysis failed. Retry to run it again.',
    };
  }
  if (finding.analysis_status !== 'completed') return null;

  const sandbox = finding.analysis?.sandboxAnalysis;
  const triage = finding.analysis?.triage;
  if (sandbox?.isExploitable === true) {
    return {
      icon: ShieldAlert,
      label: 'Exploitable',
      className: 'text-red-400',
      spin: false,
      tooltip: sandbox.summary || 'Codebase analysis confirmed this vulnerability is exploitable',
    };
  }
  if (sandbox?.isExploitable === false) {
    return {
      icon: ShieldCheck,
      label: 'Not exploitable',
      className: 'text-green-400',
      spin: false,
      tooltip: sandbox.summary || 'Codebase analysis determined this is not exploitable',
    };
  }
  if (triage?.suggestedAction === 'dismiss') {
    return {
      icon: ShieldX,
      label: 'Safe to dismiss',
      className: 'text-green-400',
      spin: false,
      tooltip: triage.needsSandboxReasoning || 'Triage determined this can be safely dismissed',
    };
  }
  if (triage?.suggestedAction === 'manual_review') {
    return {
      icon: Eye,
      label: 'Needs review',
      className: 'text-yellow-400',
      spin: false,
      tooltip: triage.needsSandboxReasoning || 'Triage flagged this for manual review',
    };
  }
  return {
    icon: Shield,
    label: triage ? 'Triage complete' : 'Analyzed',
    className: 'text-muted-foreground',
    spin: false,
    tooltip: triage?.needsSandboxReasoning || null,
  };
}

function OutcomeLabel({ outcome }: { outcome: Outcome }) {
  const content = (
    <span className={cn('flex items-center gap-1.5', outcome.className)}>
      <outcome.icon
        className={cn('size-3.5', outcome.spin && 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
      {outcome.label}
    </span>
  );
  if (!outcome.tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-xs">
        {outcome.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

type Severity = 'critical' | 'high' | 'medium' | 'low';

function isSeverity(value: string): value is Severity {
  return ['critical', 'high', 'medium', 'low'].includes(value);
}

type SecurityFindingRowProps = {
  finding: SecurityFinding;
  onClick: () => void;
  onStartAnalysis?: (findingId: string, options?: { retrySandboxOnly?: boolean }) => void;
  isStartingAnalysis?: boolean;
};

function formatCompactDistance(date: Date) {
  const now = new Date();
  const days = Math.abs(differenceInDays(now, date));
  if (days >= 1) return `${days}d`;
  const hours = Math.abs(differenceInHours(now, date));
  if (hours >= 1) return `${hours}h`;
  return `${Math.abs(differenceInMinutes(now, date))}m`;
}

export function SecurityFindingRow({
  finding,
  onClick,
  onStartAnalysis,
  isStartingAnalysis,
}: SecurityFindingRowProps) {
  const severity: Severity = isSeverity(finding.severity) ? finding.severity : 'medium';
  const canStartAnalysis =
    finding.status === 'open' &&
    (!finding.analysis_status || finding.analysis_status === 'failed') &&
    Boolean(onStartAnalysis) &&
    !isStartingAnalysis;
  const outcome = getOutcome(finding);
  const isHighlighted =
    finding.status === 'open' &&
    finding.sla_due_at !== null &&
    isPast(new Date(finding.sla_due_at));

  const startAnalysis = () => {
    const retrySandboxOnly =
      Boolean(finding.analysis?.triage) && finding.analysis_status === 'failed';
    onStartAnalysis?.(finding.id, { retrySandboxOnly });
  };

  return (
    <article
      className={cn(
        'hover:bg-muted/50 grid grid-cols-[minmax(0,1fr)_auto] items-center transition-colors',
        isHighlighted && 'bg-red-500/5'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="focus-visible:ring-ring group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-md px-4 py-3 text-left focus-visible:ring-2 focus-visible:outline-none md:grid-cols-[72px_minmax(0,1fr)_140px_16px] md:gap-x-3"
        aria-label={`View ${finding.title}`}
      >
        <SeverityBadge severity={severity} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{finding.title}</span>
          <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
            <Package className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{finding.package_name}</span>
          </span>
        </span>
        <ChevronRight
          className="text-muted-foreground size-4 md:col-start-4 md:row-start-1"
          aria-hidden="true"
        />
        <span className="col-start-2 text-xs md:col-start-3 md:row-start-1">
          {outcome ? (
            <OutcomeLabel outcome={outcome} />
          ) : (
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Shield className="size-3.5" aria-hidden="true" />
              Not analyzed
            </span>
          )}
        </span>
      </button>

      <div className="flex items-center justify-end pr-4">
        {canStartAnalysis ? (
          <Button variant="outline" size="sm" onClick={startAnalysis} className="gap-1">
            <Brain className="size-3" aria-hidden="true" />
            {finding.analysis_status === 'failed' ? 'Retry' : 'Analyze'}
          </Button>
        ) : isStartingAnalysis ? (
          <Button variant="outline" size="sm" disabled className="gap-1">
            <Loader2
              className="size-3 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {manualAnalysisAdmissionCopy.pendingLabel}
          </Button>
        ) : finding.analysis?.triage?.suggestedAction === 'manual_review' &&
          finding.status === 'open' ? (
          <Button variant="outline" size="sm" onClick={onClick} className="gap-1">
            <Eye className="size-3" aria-hidden="true" />
            Review
          </Button>
        ) : finding.status === 'fixed' || finding.status === 'ignored' ? (
          <Button variant="outline" size="sm" onClick={onClick} className="gap-1">
            <Eye className="size-3" aria-hidden="true" />
            View details
          </Button>
        ) : null}
      </div>
    </article>
  );
}
