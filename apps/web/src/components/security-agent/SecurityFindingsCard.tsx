'use client';

import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Settings2,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { SecurityFindingWithRemediation } from '@/lib/security-agent/db/security-remediation';
import { cn } from '@/lib/utils';
import { RepositoryFilter } from './RepositoryFilter';
import { SecurityAgentActionBar, SecurityAgentActionBarField } from './SecurityAgentActionBar';
import { SecurityFindingRow } from './SecurityFindingRow';
import { getFindingListGridClass } from './security-finding-list-presentation';

type Repository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

type Stats = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  open: number;
  fixed: number;
  ignored: number;
};

type FindingsViewState = {
  isSyncing: boolean;
  isLoading: boolean;
  isEnabled: boolean;
  hasIntegration: boolean;
};

type SecurityFindingsCardProps = {
  findings: SecurityFindingWithRemediation[];
  repositories: Repository[];
  stats: Stats;
  totalCount: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onFindingClick: (finding: SecurityFindingWithRemediation) => void;
  onSync: (repoFullName?: string) => void;
  state: FindingsViewState;
  filters: {
    status?: string;
    severity?: string;
    repoFullName?: string;
    outcomeFilter?: string;
    overdue?: boolean;
  };
  onFiltersChange: (filters: {
    status?: string;
    severity?: string;
    repoFullName?: string;
    outcomeFilter?: string;
    overdue?: boolean;
  }) => void;
  installUrl?: string;
  onEnableClick: () => void;
  lastSyncTime?: string | null;
  onStartAnalysis?: (
    findingId: string,
    options?: { forceSandbox?: boolean; retrySandboxOnly?: boolean }
  ) => void;
  startingAnalysisIds?: Set<string>;
  onStartRemediation?: (findingId: string) => void;
  onRetryRemediation?: (findingId: string) => void;
  onCancelRemediation?: (attemptId: string, findingId?: string) => void;
  startingRemediationIds?: Set<string>;
  cancellingRemediationAttemptIds?: Set<string>;
  runningCount?: number;
  concurrencyLimit?: number;
  showSla?: boolean;
  sortBy: 'severity_desc' | 'severity_asc' | 'sla_due_at_asc';
  onSortByChange: (sortBy: 'severity_desc' | 'severity_asc' | 'sla_due_at_asc') => void;
};

const STATUS_IMPLYING_OUTCOMES = new Set([
  'exploitable',
  'not_exploitable',
  'safe_to_dismiss',
  'needs_review',
  'triage_complete',
  'fixed',
  'dismissed',
]);

const skeletonRowKeys = ['skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4', 'skeleton-5'];

export function SecurityFindingsCard({
  findings,
  repositories,
  stats,
  totalCount,
  page,
  pageSize,
  onPageChange,
  onFindingClick,
  onSync,
  state,
  filters,
  onFiltersChange,
  installUrl,
  onEnableClick,
  lastSyncTime,
  onStartAnalysis,
  startingAnalysisIds,
  onStartRemediation,
  onRetryRemediation,
  onCancelRemediation,
  startingRemediationIds,
  cancellingRemediationAttemptIds,
  runningCount = 0,
  concurrencyLimit = 3,
  showSla = true,
  sortBy,
  onSortByChange,
}: SecurityFindingsCardProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);
  const closedCount = stats.fixed + stats.ignored;
  const analysisAtCapacity = runningCount >= concurrencyLimit;
  const hasActiveFilters = Boolean(
    filters.severity || filters.repoFullName || filters.outcomeFilter || filters.overdue
  );
  const listGridClass = getFindingListGridClass(showSla);

  const handleStatusChange = (value: string) => {
    const status = value === 'all' ? undefined : value;
    onFiltersChange({
      ...filters,
      status,
      outcomeFilter:
        status && filters.outcomeFilter && STATUS_IMPLYING_OUTCOMES.has(filters.outcomeFilter)
          ? undefined
          : filters.outcomeFilter,
    });
  };

  const handleOutcomeFilterChange = (value: string) => {
    const outcomeFilter = value === 'all' ? undefined : value;
    onFiltersChange({
      ...filters,
      outcomeFilter,
      status:
        outcomeFilter && STATUS_IMPLYING_OUTCOMES.has(outcomeFilter) ? undefined : filters.status,
    });
  };

  if (!state.hasIntegration) {
    return (
      <div className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
        <Shield className="text-muted-foreground mb-4 size-12 opacity-40" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Connect GitHub to get started</h2>
        <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
          Install Kilo GitHub App to sync Dependabot alerts and manage findings across your
          repositories.
        </p>
        {installUrl && (
          <Button
            asChild
            className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 mt-6"
          >
            <Link href={installUrl}>Install GitHub App</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SecurityAgentActionBar label="Findings controls">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <fieldset className="min-w-0">
            <legend className="sr-only">Finding state</legend>
            <div className="border-input bg-input-background flex min-h-11 w-full items-center gap-1 rounded-lg border p-1 sm:min-h-9 sm:w-fit">
              <button
                type="button"
                onClick={() => handleStatusChange(filters.status === 'open' ? 'all' : 'open')}
                aria-pressed={filters.status === 'open'}
                className={cn(
                  'focus-visible:ring-ring flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:flex-none',
                  filters.status === 'open'
                    ? 'bg-surface-selected text-foreground'
                    : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                )}
              >
                <AlertCircle className="size-4" aria-hidden="true" />
                <span>
                  <span className="font-mono tabular-nums">{stats.open}</span> open
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleStatusChange(filters.status === 'closed' ? 'all' : 'closed')}
                aria-pressed={filters.status === 'closed'}
                className={cn(
                  'focus-visible:ring-ring flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:flex-none',
                  filters.status === 'closed'
                    ? 'bg-surface-selected text-foreground'
                    : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                )}
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                <span>
                  <span className="font-mono tabular-nums">{closedCount}</span> closed
                </span>
              </button>
            </div>
          </fieldset>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
            <Badge
              variant={analysisAtCapacity ? 'destructive' : 'secondary'}
              className="min-h-8 px-3"
              title={`${runningCount} of ${concurrencyLimit} analysis slots are active or queued. New requests are disabled at capacity.`}
            >
              <span className="font-mono tabular-nums">
                {runningCount}/{concurrencyLimit}
              </span>{' '}
              analysis capacity
            </Badge>
            {state.isEnabled ? (
              <>
                {lastSyncTime && (
                  <span className="text-muted-foreground flex min-h-8 items-center gap-1.5 text-xs whitespace-nowrap">
                    <Clock className="size-3.5" aria-hidden="true" />
                    Last synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                  </span>
                )}
                <Button
                  variant="outline"
                  className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                  onClick={() => onSync()}
                  disabled={state.isSyncing}
                >
                  {state.isSyncing ? (
                    <Loader2
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                  {state.isSyncing ? 'Syncing findings...' : 'Sync findings'}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                onClick={onEnableClick}
              >
                <Settings2 aria-hidden="true" />
                Enable Security Agent
              </Button>
            )}
          </div>
        </div>

        <div className="border-border mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_minmax(11rem,1fr)_minmax(12rem,1fr)]">
          <SecurityAgentActionBarField id="findings-repository" label="Repository">
            <RepositoryFilter
              id="findings-repository"
              className="min-h-11 sm:min-h-9 sm:w-full"
              repositories={repositories}
              value={filters.repoFullName}
              onValueChange={repoFullName => onFiltersChange({ ...filters, repoFullName })}
              isLoading={state.isLoading}
            />
          </SecurityAgentActionBarField>

          <SecurityAgentActionBarField id="findings-severity" label="Severity">
            <Select
              value={filters.severity || 'all'}
              onValueChange={severity =>
                onFiltersChange({ ...filters, severity: severity === 'all' ? undefined : severity })
              }
            >
              <SelectTrigger id="findings-severity" className="min-h-11 w-full sm:min-h-9">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </SecurityAgentActionBarField>

          <SecurityAgentActionBarField id="findings-outcome" label="Analysis outcome">
            <Select
              value={filters.outcomeFilter || 'all'}
              onValueChange={handleOutcomeFilterChange}
            >
              <SelectTrigger id="findings-outcome" className="min-h-11 w-full sm:min-h-9">
                <SelectValue placeholder="Outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="not_analyzed">Not analyzed</SelectItem>
                <SelectItem value="failed">Analysis failed</SelectItem>
                <SelectItem value="exploitable">Exploitable</SelectItem>
                <SelectItem value="not_exploitable">Not exploitable</SelectItem>
                <SelectItem value="safe_to_dismiss">Safe to dismiss</SelectItem>
                <SelectItem value="needs_review">Needs review</SelectItem>
                <SelectItem value="triage_complete">Triage complete</SelectItem>
                <SelectItem value="fixed">Fixed</SelectItem>
                <SelectItem value="dismissed">Dismissed</SelectItem>
              </SelectContent>
            </Select>
          </SecurityAgentActionBarField>

          <SecurityAgentActionBarField id="findings-sort" label="Sort by">
            <Select value={sortBy} onValueChange={onSortByChange}>
              <SelectTrigger id="findings-sort" className="min-h-11 w-full sm:min-h-9">
                <ArrowUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
                <SelectValue placeholder="Sort findings" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="severity_desc">
                  <span className="flex items-center gap-1.5">
                    Severity <ArrowDown className="size-3" aria-hidden="true" />
                  </span>
                </SelectItem>
                <SelectItem value="severity_asc">
                  <span className="flex items-center gap-1.5">
                    Severity <ArrowUp className="size-3" aria-hidden="true" />
                  </span>
                </SelectItem>
                {showSla && <SelectItem value="sla_due_at_asc">SLA due date</SelectItem>}
              </SelectContent>
            </Select>
          </SecurityAgentActionBarField>
        </div>
      </SecurityAgentActionBar>

      <section
        aria-label={
          filters.status === 'closed'
            ? 'Closed findings'
            : filters.status === 'open'
              ? 'Open findings'
              : 'Security findings'
        }
        className="border-border bg-surface-raised overflow-hidden rounded-xl border"
      >
        <div
          className={cn(
            'border-border bg-surface-inset text-muted-foreground type-label hidden gap-4 border-b px-5 py-2.5 xl:grid',
            listGridClass
          )}
          aria-hidden="true"
        >
          <span>Security Finding</span>
          <span>Analysis</span>
          {showSla && <span>SLA Deadline</span>}
          <span className="text-right">Action</span>
          <span />
        </div>

        {state.isLoading ? (
          <FindingsSkeleton showSla={showSla} />
        ) : findings.length === 0 ? (
          <FindingsEmptyState
            status={filters.status}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={() => onFiltersChange(filters.status ? { status: filters.status } : {})}
          />
        ) : (
          <ul className="divide-border divide-y">
            {findings.map(finding => (
              <SecurityFindingRow
                key={finding.id}
                finding={finding}
                onClick={() => onFindingClick(finding)}
                onStartAnalysis={onStartAnalysis}
                isStartingAnalysis={startingAnalysisIds?.has(finding.id)}
                analysisAtCapacity={analysisAtCapacity}
                onStartRemediation={onStartRemediation}
                onRetryRemediation={onRetryRemediation}
                onCancelRemediation={onCancelRemediation}
                isStartingRemediation={startingRemediationIds?.has(finding.id)}
                isCancellingRemediation={
                  !!finding.remediationSummary?.latestAttemptId &&
                  cancellingRemediationAttemptIds?.has(finding.remediationSummary.latestAttemptId)
                }
                slaDisplay={showSla ? 'visible' : 'hidden'}
              />
            ))}
          </ul>
        )}
      </section>

      {totalCount > 0 && !state.isLoading && (
        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground type-code tabular-nums">
            Showing {startItem}-{endItem} of {totalCount}
          </p>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Button
              variant="outline"
              className="min-h-control-touch sm:h-control-default sm:min-h-0"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <span className="text-muted-foreground type-code px-1 tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              className="min-h-control-touch sm:h-control-default sm:min-h-0"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingsSkeleton({ showSla }: { showSla: boolean }) {
  return (
    <div className="divide-border divide-y">
      <output className="sr-only">Loading Security Findings</output>
      {skeletonRowKeys.map(rowKey => (
        <div
          key={rowKey}
          className={cn(
            'grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:items-center',
            getFindingListGridClass(showSla)
          )}
        >
          <div className="flex items-center gap-3 sm:col-span-2 xl:col-span-1">
            <Skeleton className="h-5 w-16 shrink-0" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <Skeleton className="h-7 w-28" />
          {showSla && (
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-28" />
            </div>
          )}
          <div className="flex items-center justify-end gap-2 sm:col-span-2 xl:col-span-2 xl:grid xl:grid-cols-[minmax(9rem,auto)_2.25rem]">
            <Skeleton className="h-9 w-full sm:w-28 xl:justify-self-end" />
            <Skeleton className="size-9 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingsEmptyState({
  status,
  hasActiveFilters,
  onClearFilters,
}: {
  status?: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const Icon = hasActiveFilters ? AlertTriangle : ShieldCheck;
  const title = hasActiveFilters
    ? 'No findings match these filters'
    : status === 'open'
      ? 'No open findings'
      : status === 'closed'
        ? 'No closed findings'
        : 'No findings';
  const description = hasActiveFilters
    ? 'Change or clear filters to include more Security Findings.'
    : status === 'open'
      ? 'New Security Findings will appear here after the next successful sync.'
      : status === 'closed'
        ? 'Fixed and dismissed Security Findings will appear here.'
        : 'Security Findings will appear here after the next successful sync.';

  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center sm:py-16">
      <div className="border-border bg-surface-inset text-muted-foreground flex size-11 items-center justify-center rounded-full border">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h3 className="type-heading mt-4">{title}</h3>
      <p className="text-muted-foreground type-body mt-2 max-w-[52ch]">{description}</p>
      {hasActiveFilters && (
        <Button type="button" variant="outline" className="mt-5" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
