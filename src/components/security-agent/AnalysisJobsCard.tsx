'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Brain,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Package,
  RefreshCw,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { differenceInDays, differenceInHours, differenceInMinutes } from 'date-fns';
import { toast } from 'sonner';
import { SeverityBadge } from './SeverityBadge';
import { FindingDetailDialog } from './FindingDetailDialog';
import { DismissFindingDialog, type DismissReason } from './DismissFindingDialog';
import { cn } from '@/lib/utils';
import type { SecurityFinding } from '@kilocode/db/schema';
import { isGitHubIntegrationError } from '@/lib/security-agent/core/error-display';

type AnalysisJobsCardProps = {
  organizationId?: string;
  onGitHubError?: (error: string | null) => void;
};

type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed';
type Severity = 'critical' | 'high' | 'medium' | 'low';

const statusConfig: Record<
  AnalysisStatus,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    badgeClass: string;
  }
> = {
  pending: {
    icon: Clock,
    label: 'Queued',
    badgeClass: 'border-gray-500/30 bg-gray-500/20 text-gray-400',
  },
  running: {
    icon: Loader2,
    label: 'Analyzing',
    badgeClass: 'border-yellow-500/30 bg-yellow-500/20 text-yellow-400',
  },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    badgeClass: 'border-green-500/30 bg-green-500/20 text-green-400',
  },
  failed: {
    icon: XCircle,
    label: 'Failed',
    badgeClass: 'border-red-500/30 bg-red-500/20 text-red-400',
  },
};

const PAGE_SIZE = 10;

function formatCompactTimeAgo(date: Date) {
  const now = new Date();
  const days = Math.abs(differenceInDays(now, date));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.abs(differenceInHours(now, date));
  if (hours >= 1) return `${hours}h ago`;
  const minutes = Math.abs(differenceInMinutes(now, date));
  return `${minutes}m ago`;
}

// ─── Row sub-components ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AnalysisStatus | null }) {
  if (!status) return null;
  const info = statusConfig[status];
  const Icon = info.icon;
  return (
    <Badge variant="outline" className={info.badgeClass}>
      <Icon className={cn('mr-1 h-3 w-3', status === 'running' && 'animate-spin')} />
      {info.label}
    </Badge>
  );
}

function AnalysisJobRow({
  finding,
  onRetry,
  isRetrying,
  retryDisabled,
  onClick,
}: {
  finding: SecurityFinding;
  onRetry: (id: string) => void;
  isRetrying: boolean;
  retryDisabled: boolean;
  onClick: () => void;
}) {
  const status = finding.analysis_status as AnalysisStatus | null;
  const canRetry = status === 'failed' || (status === 'completed' && finding.analysis);

  const time =
    finding.analysis_completed_at && (status === 'completed' || status === 'failed')
      ? formatCompactTimeAgo(new Date(finding.analysis_completed_at))
      : finding.analysis_started_at
        ? formatCompactTimeAgo(new Date(finding.analysis_started_at))
        : null;

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
        status === 'failed' && 'bg-red-500/5'
      )}
    >
      {/* Severity */}
      <div>
        <SeverityBadge severity={finding.severity as Severity} size="sm" />
      </div>

      {/* Title + package */}
      <div className="min-w-0">
        <h4 className="truncate text-sm font-medium">{finding.title}</h4>
        <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
          <Package className="h-3 w-3" />
          {finding.package_name}
        </span>
      </div>

      {/* Status + time */}
      <div className="text-xs">
        <StatusBadge status={status} />
        {time && <div className="text-muted-foreground mt-1 text-xs">{time}</div>}
      </div>

      {/* Action */}
      <div className="flex items-center justify-end">
        {canRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={e => {
              e.stopPropagation();
              onRetry(finding.id);
            }}
            disabled={isRetrying || retryDisabled}
            className="gap-1"
          >
            <RotateCcw className={cn('h-3 w-3', isRetrying && 'animate-spin')} />
            {isRetrying ? 'Starting...' : 'Retry'}
          </Button>
        )}
      </div>

      {/* Detail chevron */}
      <ChevronRight className="text-muted-foreground h-4 w-4" />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function AnalysisJobsCard({ organizationId, onGitHubError }: AnalysisJobsCardProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [startingAnalysisId, setStartingAnalysisId] = useState<string | null>(null);
  const [selectedFinding, setSelectedFinding] = useState<SecurityFinding | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isOrg = !!organizationId;
  const offset = (currentPage - 1) * PAGE_SIZE;

  const { data, isLoading, isFetching } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.listAnalysisJobs.queryOptions({
          organizationId,
          limit: PAGE_SIZE,
          offset,
        })
      : trpc.securityAgent.listAnalysisJobs.queryOptions({
          limit: PAGE_SIZE,
          offset,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result) return false;
      const findings = result.jobs || [];
      const hasActiveJobs = findings.some(f =>
        ['pending', 'running'].includes(f.analysis_status || '')
      );
      return hasActiveJobs ? 5000 : false;
    },
  });

  const handleMutationSuccess = async () => {
    onGitHubError?.(null);
    await queryClient.invalidateQueries();
    setStartingAnalysisId(null);
  };

  const handleMutationError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isGitHubIntegrationError(error)) {
      onGitHubError?.(message);
      toast.error('GitHub Integration Error', {
        description: 'The GitHub App may have been uninstalled. Please check your integrations.',
      });
    } else {
      toast.error('Analysis Failed', { description: message, duration: 8000 });
    }
    setStartingAnalysisId(null);
  };

  const retryOrgMutation = useMutation(
    trpc.organizations.securityAgent.startAnalysis.mutationOptions({
      onSuccess: handleMutationSuccess,
      onError: handleMutationError,
    })
  );

  const retryUserMutation = useMutation(
    trpc.securityAgent.startAnalysis.mutationOptions({
      onSuccess: handleMutationSuccess,
      onError: handleMutationError,
    })
  );

  const handleRetry = (findingId: string) => {
    setStartingAnalysisId(findingId);
    // If the finding has triage data, retry only sandbox analysis to avoid redundant triage
    const jobs = data?.jobs || [];
    const finding = jobs.find(f => f.id === findingId);
    const retrySandboxOnly = !!finding?.analysis?.triage && finding.analysis_status === 'failed';
    if (isOrg) {
      retryOrgMutation.mutate({ organizationId: organizationId, findingId, retrySandboxOnly });
    } else {
      retryUserMutation.mutate({ findingId, retrySandboxOnly });
    }
  };

  // Dismiss mutation (organization)
  const dismissOrgMutation = useMutation(
    trpc.organizations.securityAgent.dismissFinding.mutationOptions({
      onSuccess: () => {
        toast.success('Finding dismissed');
        void queryClient.invalidateQueries();
        setDismissDialogOpen(false);
        setDetailDialogOpen(false);
        setSelectedFinding(null);
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  // Dismiss mutation (user)
  const dismissUserMutation = useMutation(
    trpc.securityAgent.dismissFinding.mutationOptions({
      onSuccess: () => {
        toast.success('Finding dismissed');
        void queryClient.invalidateQueries();
        setDismissDialogOpen(false);
        setDetailDialogOpen(false);
        setSelectedFinding(null);
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  const handleDismiss = (reason: DismissReason, comment?: string) => {
    if (!selectedFinding) return;
    if (isOrg && organizationId) {
      dismissOrgMutation.mutate({
        organizationId,
        findingId: selectedFinding.id,
        reason,
        comment,
      });
    } else {
      dismissUserMutation.mutate({
        findingId: selectedFinding.id,
        reason,
        comment,
      });
    }
  };

  const handleRowClick = (finding: SecurityFinding) => {
    setSelectedFinding(finding);
    setDetailDialogOpen(true);
  };

  const handleOpenDismissDialog = () => {
    setDetailDialogOpen(false);
    setDismissDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  const findings = data?.jobs || [];
  const total = data?.total || 0;
  const runningCount = data?.runningCount || 0;
  const concurrencyLimit = data?.concurrencyLimit || 3;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const startItem = offset + 1;
  const endItem = Math.min(offset + findings.length, total);
  const isDismissing = isOrg ? dismissOrgMutation.isPending : dismissUserMutation.isPending;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-5">
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4" />
            {runningCount} Running
          </span>
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4" />
            {findings.filter(f => f.analysis_status === 'completed').length} Completed
          </span>
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <XCircle className="h-4 w-4" />
            {findings.filter(f => f.analysis_status === 'failed').length} Failed
          </span>
        </div>
        <Badge variant={runningCount >= concurrencyLimit ? 'destructive' : 'secondary'}>
          {runningCount}/{concurrencyLimit} capacity
        </Badge>
      </div>

      {/* Rows */}
      <div className="rounded-lg border border-gray-800">
        {findings.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center py-12">
            <Brain className="mb-2 h-8 w-8 opacity-50" />
            <p>No analysis jobs yet</p>
            <p className="mt-1 text-xs">
              Click &quot;Start Analysis&quot; on any finding to begin.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {findings.map(finding => (
              <AnalysisJobRow
                key={finding.id}
                finding={finding}
                onRetry={handleRetry}
                isRetrying={startingAnalysisId === finding.id}
                retryDisabled={runningCount >= concurrencyLimit}
                onClick={() => handleRowClick(finding)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <p className="text-muted-foreground text-sm">
            Showing {startItem}–{endItem} of {total}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage <= 1 || isFetching}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-muted-foreground text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => p + 1)}
              disabled={currentPage >= totalPages || isFetching}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Finding Detail Dialog */}
      <FindingDetailDialog
        finding={selectedFinding}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        onDismiss={handleOpenDismissDialog}
        canDismiss={selectedFinding?.status === 'open'}
        organizationId={organizationId}
      />

      {/* Dismiss Finding Dialog */}
      <DismissFindingDialog
        finding={selectedFinding}
        open={dismissDialogOpen}
        onOpenChange={setDismissDialogOpen}
        onDismiss={handleDismiss}
        isLoading={isDismissing}
      />
    </div>
  );
}
