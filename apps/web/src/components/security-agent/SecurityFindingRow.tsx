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

type Outcome = {
  icon: typeof CheckCircle2;
  label: string;
  className: string;
  spin: boolean;
  tooltip: string | null;
};

function getOutcome(finding: SecurityFinding): Outcome | null {
  // Resolved findings: the finding status takes precedence over analysis results
  if (finding.status === 'fixed') {
    const fixedAgo = finding.fixed_at
      ? `Fixed ${formatCompactDistance(new Date(finding.fixed_at))} ago`
      : null;
    return {
      icon: CheckCircle2,
      label: 'Fixed',
      className: 'text-green-400',
      spin: false,
      tooltip: fixedAgo,
    };
  }
  if (finding.status === 'ignored') {
    const reason = finding.ignored_reason ? finding.ignored_reason.replace(/_/g, ' ') : null;
    return {
      icon: XCircle,
      label: 'Dismissed',
      className: 'text-muted-foreground',
      spin: false,
      tooltip: reason,
    };
  }

  // In-progress / failed analysis
  if (finding.analysis_status === 'pending') {
    return {
      icon: Loader2,
      label: 'Analyzing',
      className: 'text-yellow-400',
      spin: true,
      tooltip: 'Analysis is queued',
    };
  }
  if (finding.analysis_status === 'running') {
    return {
      icon: Loader2,
      label: 'Analyzing',
      className: 'text-yellow-400',
      spin: true,
      tooltip: 'Analysis is running',
    };
  }
  if (finding.analysis_status === 'failed') {
    return {
      icon: XCircle,
      label: 'Analysis Failed',
      className: 'text-red-400',
      spin: false,
      tooltip: finding.analysis_error || 'Unknown error',
    };
  }

  // Completed analysis — show the result
  if (finding.analysis_status === 'completed') {
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
        label: 'Not Exploitable',
        className: 'text-green-400',
        spin: false,
        tooltip: sandbox.summary || 'Codebase analysis determined this is not exploitable',
      };
    }
    if (triage?.suggestedAction === 'dismiss') {
      return {
        icon: ShieldX,
        label: 'Safe to Dismiss',
        className: 'text-green-400',
        spin: false,
        tooltip: triage.needsSandboxReasoning || 'Triage determined this can be safely dismissed',
      };
    }
    if (triage?.suggestedAction === 'manual_review') {
      return {
        icon: Eye,
        label: 'Needs Review',
        className: 'text-yellow-400',
        spin: false,
        tooltip: triage.needsSandboxReasoning || 'Triage flagged this for manual review',
      };
    }
    return {
      icon: Shield,
      label: triage ? 'Triage Complete' : 'Analyzed',
      className: 'text-muted-foreground',
      spin: false,
      tooltip: triage?.needsSandboxReasoning || null,
    };
  }
  return null;
}

function OutcomeLabel({ outcome }: { outcome: Outcome }) {
  const content = (
    <span className={cn('flex items-center gap-1.5', outcome.className)}>
      <outcome.icon className={cn('h-3.5 w-3.5', outcome.spin && 'animate-spin')} />
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
  const minutes = Math.abs(differenceInMinutes(now, date));
  return `${minutes}m`;
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
    onStartAnalysis &&
    !isStartingAnalysis;

  const handleStartAnalysis = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onStartAnalysis) {
      const retrySandboxOnly = !!finding.analysis?.triage && finding.analysis_status === 'failed';
      onStartAnalysis(finding.id, { retrySandboxOnly });
    }
  };

  const outcome = getOutcome(finding);
  const isHighlighted =
    finding.status === 'open' && !!finding.sla_due_at && isPast(new Date(finding.sla_due_at));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'hover:bg-muted/50 grid w-full cursor-pointer grid-cols-[72px_1fr_140px_80px_16px] items-center gap-x-1.5 px-4 py-3 text-left transition-colors',
        isHighlighted ? 'bg-red-500/5' : ''
      )}
    >
      {/* Severity */}
      <div>
        <SeverityBadge severity={severity} size="sm" />
      </div>

      {/* Title + package */}
      <div className="min-w-0">
        <h4 className="truncate text-sm font-medium">{finding.title}</h4>
        <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
          <Package className="h-3 w-3" />
          {finding.package_name}
        </span>
      </div>

      {/* Outcome */}
      <div className="text-xs">
        {outcome ? (
          <OutcomeLabel outcome={outcome} />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground/50 flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                Not Analyzed
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Click Analyze to assess this vulnerability
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Action */}
      <div className="flex items-center justify-end">
        {canStartAnalysis ? (
          finding.analysis_status === 'failed' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartAnalysis}
                  disabled={isStartingAnalysis}
                  className="gap-1"
                >
                  <Brain className="h-3 w-3" />
                  Retry
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {finding.analysis_error ||
                  finding.analysis?.triage?.needsSandboxReasoning ||
                  'Analysis failed'}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartAnalysis}
              disabled={isStartingAnalysis}
              className="gap-1"
            >
              <Brain className="h-3 w-3" />
              Analyze
            </Button>
          )
        ) : isStartingAnalysis ? (
          <Button variant="outline" size="sm" disabled className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Starting
          </Button>
        ) : finding.analysis?.triage?.suggestedAction === 'manual_review' &&
          finding.status === 'open' ? (
          <Button variant="outline" size="sm" onClick={onClick} className="gap-1">
            <Eye className="h-3 w-3" />
            Review
          </Button>
        ) : finding.status === 'fixed' || finding.status === 'ignored' ? (
          <Button variant="outline" size="sm" onClick={onClick} className="gap-1">
            <Eye className="h-3 w-3" />
            View Details
          </Button>
        ) : null}
      </div>

      {/* Detail chevron */}
      <ChevronRight className="text-muted-foreground h-4 w-4" />
    </div>
  );
}
