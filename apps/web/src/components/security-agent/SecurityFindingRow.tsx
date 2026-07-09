'use client';

import {
  Brain,
  ChevronRight,
  Eye,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SecurityFindingWithRemediation } from '@/lib/security-agent/db/security-remediation';
import { cn } from '@/lib/utils';
import { SeverityBadge } from './SeverityBadge';
import {
  isAwaitingManualAnalysisAdmission,
  manualAnalysisAdmissionCopy,
  manualAnalysisCapacityFullCopy,
} from './manual-analysis-admission-copy';
import {
  getAnalysisPresentation,
  getDeadlinePresentation,
  getFindingListGridClass,
  type FindingStatusPresentation,
  type FindingTone,
} from './security-finding-list-presentation';

type Severity = 'critical' | 'high' | 'medium' | 'low';

type SecurityFindingRowProps = {
  finding: SecurityFindingWithRemediation;
  onClick: () => void;
  onStartAnalysis?: (
    findingId: string,
    options?: { forceSandbox?: boolean; retrySandboxOnly?: boolean }
  ) => void;
  isStartingAnalysis?: boolean;
  analysisAtCapacity?: boolean;
  onStartRemediation?: (findingId: string) => void;
  onRetryRemediation?: (findingId: string) => void;
  onCancelRemediation?: (attemptId: string, findingId?: string) => void;
  isStartingRemediation?: boolean;
  isCancellingRemediation?: boolean;
  slaDisplay?: 'visible' | 'hidden';
};

const toneStyles: Record<FindingTone, { status: string; text: string }> = {
  success: {
    status: 'border-status-success-border bg-status-success-surface text-status-success',
    text: 'text-status-success',
  },
  warning: {
    status: 'border-status-warning-border bg-status-warning-surface text-status-warning',
    text: 'text-status-warning',
  },
  destructive: {
    status:
      'border-status-destructive-border bg-status-destructive-surface text-status-destructive',
    text: 'text-status-destructive',
  },
  neutral: {
    status: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
    text: 'text-status-neutral',
  },
};

function isSeverity(value: string): value is Severity {
  return ['critical', 'high', 'medium', 'low'].includes(value);
}

function FindingStatusCell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative z-10 min-w-0 pointer-events-none', className)}>
      <div className="text-muted-foreground type-label mb-2 xl:hidden">{label}</div>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: FindingStatusPresentation }) {
  const Icon = status.icon;
  return (
    <span
      className={cn(
        'type-label inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        toneStyles[status.tone].status
      )}
      title={status.tooltip ?? undefined}
    >
      <Icon
        className={cn('size-3.5', status.spinning && 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
      {status.label}
    </span>
  );
}

export function SecurityFindingRow({
  finding,
  onClick,
  onStartAnalysis,
  isStartingAnalysis,
  analysisAtCapacity = false,
  onStartRemediation,
  onRetryRemediation,
  onCancelRemediation,
  isStartingRemediation,
  isCancellingRemediation,
  slaDisplay = 'visible',
}: SecurityFindingRowProps) {
  const severity: Severity = isSeverity(finding.severity) ? finding.severity : 'medium';
  const showAnalysisAction =
    finding.status === 'open' &&
    (!finding.analysis_status || finding.analysis_status === 'failed') &&
    Boolean(onStartAnalysis) &&
    !isStartingAnalysis;
  const isAwaitingAnalysisAdmission = isAwaitingManualAnalysisAdmission(
    Boolean(isStartingAnalysis),
    finding.analysis_status
  );
  const analysis = getAnalysisPresentation(finding);
  const deadline = getDeadlinePresentation(finding);
  const remediation = finding.remediationSummary;
  const capability = finding.remediationCapability;
  const remediationStatus = remediation?.status ?? null;
  const remediationAttemptId = capability.cancelAttemptId ?? remediation?.latestAttemptId;
  const openRemediationPrUrl =
    remediationStatus === 'pr_opened' && remediation?.prUrl ? remediation.prUrl : null;
  const showSla = slaDisplay === 'visible';

  const startAnalysis = () => {
    const retrySandboxOnly =
      Boolean(finding.analysis?.triage) && finding.analysis_status === 'failed';
    onStartAnalysis?.(finding.id, { retrySandboxOnly });
  };
  const cancelRemediation = () => {
    if (remediationAttemptId) onCancelRemediation?.(remediationAttemptId, finding.id);
  };

  return (
    <li
      className={cn(
        'hover:bg-surface-hover relative grid gap-4 px-4 py-4 transition-colors sm:grid-cols-2 sm:px-5 xl:items-center',
        getFindingListGridClass(showSla)
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="focus-visible:ring-ring absolute inset-0 z-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset"
        aria-label={`View ${finding.title}`}
      />

      <div className="relative z-10 min-w-0 pointer-events-none sm:col-span-2 xl:col-span-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex w-20 shrink-0 items-center">
            <SeverityBadge severity={severity} size="sm" />
          </div>
          <span className="type-body min-w-0 font-medium text-pretty">{finding.title}</span>
        </div>
      </div>

      <FindingStatusCell label="Analysis">
        <StatusPill status={analysis} />
      </FindingStatusCell>

      {showSla && (
        <FindingStatusCell label="SLA Deadline">
          <div className={cn('type-label flex items-start gap-2', toneStyles[deadline.tone].text)}>
            <deadline.icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-medium">{deadline.label}</div>
              <div className="text-muted-foreground mt-0.5 tabular-nums">{deadline.detail}</div>
            </div>
          </div>
        </FindingStatusCell>
      )}

      <div className="relative z-10 flex items-center justify-end gap-2 pointer-events-auto sm:col-span-2 xl:col-span-2 xl:grid xl:grid-cols-[minmax(9rem,auto)_2.25rem]">
        {openRemediationPrUrl ? (
          <Button
            variant="outline"
            asChild
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <a href={openRemediationPrUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              View PR
            </a>
          </Button>
        ) : isStartingRemediation ? (
          <Button
            variant="outline"
            disabled
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Queueing
          </Button>
        ) : capability.canCancel && remediationAttemptId && onCancelRemediation ? (
          <Button
            variant="outline"
            onClick={cancelRemediation}
            disabled={isCancellingRemediation}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            {isCancellingRemediation ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <XCircle aria-hidden="true" />
            )}
            Cancel
          </Button>
        ) : capability.canRetry && onRetryRemediation ? (
          <Button
            variant="outline"
            onClick={() => onRetryRemediation(finding.id)}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <RotateCw aria-hidden="true" />
            Retry fix
          </Button>
        ) : capability.canStart && onStartRemediation ? (
          <Button
            variant="outline"
            onClick={() => onStartRemediation(finding.id)}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <GitPullRequest aria-hidden="true" />
            Fix
          </Button>
        ) : showAnalysisAction ? (
          <Button
            variant="outline"
            onClick={startAnalysis}
            disabled={analysisAtCapacity}
            title={analysisAtCapacity ? manualAnalysisCapacityFullCopy : undefined}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <Brain aria-hidden="true" />
            {finding.analysis_status === 'failed' ? 'Retry' : 'Analyze'}
          </Button>
        ) : isAwaitingAnalysisAdmission ? (
          <Button
            variant="outline"
            disabled
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {manualAnalysisAdmissionCopy.pendingLabel}
          </Button>
        ) : finding.analysis?.triage?.suggestedAction === 'manual_review' &&
          finding.status === 'open' ? (
          <Button
            variant="outline"
            onClick={onClick}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <Eye aria-hidden="true" />
            Review
          </Button>
        ) : finding.status === 'fixed' || finding.status === 'ignored' ? (
          <Button
            variant="outline"
            onClick={onClick}
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto xl:justify-self-end"
          >
            <Eye aria-hidden="true" />
            View details
          </Button>
        ) : null}
        <ChevronRight
          className="text-muted-foreground size-4 shrink-0 xl:col-start-2 xl:justify-self-center"
          aria-hidden="true"
        />
      </div>
    </li>
  );
}
