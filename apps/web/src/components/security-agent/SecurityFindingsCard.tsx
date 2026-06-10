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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SecurityFinding } from '@kilocode/db/schema';
import { RepositoryFilter } from './RepositoryFilter';
import { SecurityFindingRow } from './SecurityFindingRow';

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
  findings: SecurityFinding[];
  repositories: Repository[];
  stats: Stats;
  totalCount: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onFindingClick: (finding: SecurityFinding) => void;
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
  onStartAnalysis?: (findingId: string, options?: { retrySandboxOnly?: boolean }) => void;
  startingAnalysisIds?: Set<string>;
  runningCount?: number;
  concurrencyLimit?: number;
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
  runningCount = 0,
  concurrencyLimit = 3,
  sortBy,
  onSortByChange,
}: SecurityFindingsCardProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);
  const closedCount = stats.fixed + stats.ignored;

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
      <div className="bg-card border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => handleStatusChange(filters.status === 'open' ? 'all' : 'open')}
            aria-pressed={filters.status === 'open'}
            className="focus-visible:ring-ring flex items-center gap-2 rounded-md text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <AlertCircle className="size-4" aria-hidden="true" />
            <span className={filters.status === 'open' ? 'font-semibold' : 'text-muted-foreground'}>
              <span className="font-mono tabular-nums">{stats.open}</span> open
            </span>
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange(filters.status === 'closed' ? 'all' : 'closed')}
            aria-pressed={filters.status === 'closed'}
            className="focus-visible:ring-ring flex items-center gap-2 rounded-md text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            <span
              className={filters.status === 'closed' ? 'font-semibold' : 'text-muted-foreground'}
            >
              <span className="font-mono tabular-nums">{closedCount}</span> closed
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={runningCount >= concurrencyLimit ? 'destructive' : 'secondary'}>
                <span className="font-mono tabular-nums">
                  {runningCount}/{concurrencyLimit}
                </span>{' '}
                capacity
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {runningCount} of {concurrencyLimit} concurrent analyses running. New requests are
              rejected at capacity.
            </TooltipContent>
          </Tooltip>
          {state.isEnabled ? (
            <>
              {lastSyncTime && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Clock className="size-3" aria-hidden="true" />
                  Last synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSync()}
                disabled={state.isSyncing}
              >
                {state.isSyncing ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                {state.isSyncing ? 'Syncing...' : 'Sync findings'}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={onEnableClick}>
              <Settings2 className="size-4" aria-hidden="true" />
              Enable Security Agent
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap">
        <RepositoryFilter
          repositories={repositories}
          value={filters.repoFullName}
          onValueChange={repoFullName => onFiltersChange({ ...filters, repoFullName })}
          isLoading={state.isLoading}
        />

        <Select
          value={filters.severity || 'all'}
          onValueChange={severity =>
            onFiltersChange({ ...filters, severity: severity === 'all' ? undefined : severity })
          }
        >
          <SelectTrigger className="w-full sm:w-auto sm:min-w-36" aria-label="Filter by severity">
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

        <Select value={filters.outcomeFilter || 'all'} onValueChange={handleOutcomeFilterChange}>
          <SelectTrigger className="w-full sm:w-auto sm:min-w-44" aria-label="Filter by outcome">
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

        <Select value={sortBy} onValueChange={onSortByChange}>
          <SelectTrigger
            className="w-full sm:w-auto sm:min-w-48 lg:ml-auto"
            aria-label="Sort findings"
          >
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
            <SelectItem value="sla_due_at_asc">SLA due date</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border-border overflow-hidden rounded-xl border">
        {state.isLoading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
            <RefreshCw
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading findings...
          </div>
        ) : findings.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center px-6 py-12 text-center">
            <AlertTriangle className="mb-2 size-8" aria-hidden="true" />
            <p>No findings match current filters.</p>
            {(filters.status ||
              filters.severity ||
              filters.repoFullName ||
              filters.outcomeFilter) && (
              <Button variant="link" size="sm" onClick={() => onFiltersChange({})} className="mt-2">
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-border divide-y">
            {findings.map(finding => (
              <SecurityFindingRow
                key={finding.id}
                finding={finding}
                onClick={() => onFindingClick(finding)}
                onStartAnalysis={onStartAnalysis}
                isStartingAnalysis={startingAnalysisIds?.has(finding.id)}
              />
            ))}
          </div>
        )}
      </div>

      {totalCount > 0 && (
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground font-mono text-sm tabular-nums">
            Showing {startItem}-{endItem} of {totalCount}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Button>
            <span className="text-muted-foreground font-mono text-sm tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
