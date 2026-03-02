'use client';

import { differenceInDays, differenceInHours, differenceInMinutes, isPast } from 'date-fns';
import { Brain, CheckCircle2, ChevronRight, Clock, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SecurityFinding } from '@kilocode/db/schema';
import { cn } from '@/lib/utils';
import { AnalysisStatusBadge } from './AnalysisStatusBadge';
import { FindingStatusBadge } from './FindingStatusBadge';
import { SeverityBadge } from './SeverityBadge';

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

function getSlaStatus(slaDueAt: string | null, status: string) {
  if (status !== 'open' || !slaDueAt) return null;

  const dueDate = new Date(slaDueAt);
  const compact = formatCompactDistance(dueDate);

  if (isPast(dueDate)) {
    return (
      <span className="flex items-center gap-1 text-xs text-red-400">
        <Clock className="h-3 w-3" />
        {compact} overdue
      </span>
    );
  }

  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs">
      <Clock className="h-3 w-3" />
      Due {compact}
    </span>
  );
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
        'hover:bg-muted/50 grid w-full cursor-pointer grid-cols-[96px_1fr_80px_100px_16px] items-center gap-x-1.5 px-4 py-3 text-left transition-colors',
        finding.status === 'open' && finding.sla_due_at && isPast(new Date(finding.sla_due_at))
          ? 'bg-red-500/5'
          : ''
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

      {/* Status + SLA/Fixed */}
      <div className="text-xs">
        <FindingStatusBadge status={finding.status} />
        <div className="mt-1">
          {getSlaStatus(finding.sla_due_at, finding.status)}
          {finding.status === 'fixed' && finding.fixed_at && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <CheckCircle2 className="h-3 w-3" />
              {formatCompactDistance(new Date(finding.fixed_at))} ago
            </span>
          )}
        </div>
      </div>

      {/* Analysis */}
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
                  className="gap-1 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
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
        ) : (
          <AnalysisStatusBadge status={finding.analysis_status} isStarting={isStartingAnalysis} />
        )}
      </div>

      {/* Detail chevron */}
      <ChevronRight className="text-muted-foreground h-4 w-4" />
    </div>
  );
}
