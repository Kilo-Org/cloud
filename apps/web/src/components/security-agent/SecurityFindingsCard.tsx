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
  isSyncing: boolean;
  isLoading: boolean;
  filters: {
    status?: string;
    severity?: string;
    repoFullName?: string;
    outcomeFilter?: string;
  };
  onFiltersChange: (filters: {
    status?: string;
    severity?: string;
    repoFullName?: string;
    outcomeFilter?: string;
  }) => void;
  isEnabled: boolean;
  hasIntegration: boolean;
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

// Outcome filters that imply their own status constraint in the DB query.
// Kept at module level to avoid re-allocating on every render.
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
  isSyncing,
  isLoading,
  filters,
  onFiltersChange,
  isEnabled,
  hasIntegration,
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

  // Calculate closed count (fixed + ignored)
  const closedCount = stats.fixed + stats.ignored;

  const handleStatusChange = (value: string) => {
    const newStatus = value === 'all' ? undefined : value;
    onFiltersChange({
      ...filters,
      status: newStatus,
      outcomeFilter:
        newStatus && filters.outcomeFilter && STATUS_IMPLYING_OUTCOMES.has(filters.outcomeFilter)
          ? undefined
          : filters.outcomeFilter,
    });
    onPageChange(1);
  };

  const handleSeverityChange = (value: string) => {
    onFiltersChange({
      ...filters,
      severity: value === 'all' ? undefined : value,
    });
    onPageChange(1);
  };

  const handleRepoChange = (value: string | undefined) => {
    onFiltersChange({
      ...filters,
      repoFullName: value,
    });
    onPageChange(1);
  };

  const handleOutcomeFilterChange = (value: string) => {
    const newOutcome = value === 'all' ? undefined : value;
    onFiltersChange({
      ...filters,
      outcomeFilter: newOutcome,
      status: newOutcome && STATUS_IMPLYING_OUTCOMES.has(newOutcome) ? undefined : filters.status,
    });
    onPageChange(1);
  };

  if (!hasIntegration) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-700 py-16">
        <Shield className="text-muted-foreground mb-4 h-12 w-12 opacity-40" />
        <h3 className="text-lg font-medium">Connect GitHub to get started</h3>
        <p className="text-muted-foreground mt-2 max-w-md text-center text-sm">
          Install the Kilo GitHub App to automatically sync Dependabot alerts and manage security
          findings across your repositories.
        </p>
        {installUrl && (
          <Button asChild className="mt-6">
            <Link href={installUrl}>Install GitHub App</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-2.5">
        {/* Left: status counts */}
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => handleStatusChange(filters.status === 'open' ? 'all' : 'open')}
            className={`flex items-center gap-2 text-sm ${
              filters.status === 'open'
                ? 'font-semibold text-white'
                : 'text-muted-foreground hover:text-white'
            }`}
          >
            <AlertCircle className="h-4 w-4" />
            <span>{stats.open} Open</span>
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange(filters.status === 'closed' ? 'all' : 'closed')}
            className={`flex items-center gap-2 text-sm ${
              filters.status === 'closed'
                ? 'font-semibold text-white'
                : 'text-muted-foreground hover:text-white'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>{closedCount} Closed</span>
          </button>
        </div>

        {/* Right: capacity badge + sync */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={runningCount >= concurrencyLimit ? 'destructive' : 'secondary'}>
                {runningCount}/{concurrencyLimit} capacity
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {runningCount}/{concurrencyLimit} concurrent analyses running. New requests are
              rejected when at capacity.
            </TooltipContent>
          </Tooltip>
          {isEnabled ? (
            <>
              {lastSyncTime && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Clock className="h-3 w-3" />
                  Last synced{' '}
                  {formatDistanceToNow(new Date(lastSyncTime), {
                    addSuffix: true,
                  })}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={() => onSync()} disabled={isSyncing}>
                {isSyncing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {isSyncing ? 'Syncing...' : 'Sync'}
              </Button>
            </>
          ) : hasIntegration ? (
            <Button variant="outline" size="sm" onClick={onEnableClick}>
              <Settings2 className="mr-2 h-4 w-4" />
              Enable Security Reviews
            </Button>
          ) : null}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <RepositoryFilter
          repositories={repositories}
          value={filters.repoFullName}
          onValueChange={handleRepoChange}
          isLoading={isLoading}
        />

        <Select value={filters.severity || 'all'} onValueChange={handleSeverityChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severity</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.outcomeFilter || 'all'} onValueChange={handleOutcomeFilterChange}>
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Outcomes</SelectItem>
            <SelectItem value="not_analyzed">Not Analyzed</SelectItem>
            <SelectItem value="failed">Analysis Failed</SelectItem>
            <SelectItem value="exploitable">Exploitable</SelectItem>
            <SelectItem value="not_exploitable">Not Exploitable</SelectItem>
            <SelectItem value="safe_to_dismiss">Safe to Dismiss</SelectItem>
            <SelectItem value="needs_review">Needs Review</SelectItem>
            <SelectItem value="triage_complete">Triage Complete</SelectItem>
            <SelectItem value="fixed">Fixed</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>

        <div className="border-muted ml-auto border-l pl-3">
          <Select value={sortBy} onValueChange={onSortByChange}>
            <SelectTrigger className="w-[180px]">
              <ArrowUpDown className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-50" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="severity_desc">
                <span className="flex items-center gap-1.5">
                  Severity <ArrowDown className="h-3 w-3" />
                </span>
              </SelectItem>
              <SelectItem value="severity_asc">
                <span className="flex items-center gap-1.5">
                  Severity <ArrowUp className="h-3 w-3" />
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Rows */}
      <div className="rounded-lg border border-gray-800">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        ) : findings.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center py-12">
            <AlertTriangle className="mb-2 h-8 w-8" />
            <p>No findings match your filters</p>
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
          <div className="divide-y divide-gray-800">
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

      {/* Pagination */}
      {totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <p className="text-muted-foreground text-sm">
            Showing {startItem}-{endItem} of {totalCount}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-muted-foreground text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
