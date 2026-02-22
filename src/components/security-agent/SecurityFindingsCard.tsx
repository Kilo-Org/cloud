'use client';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SecurityFindingRow } from './SecurityFindingRow';
import { RepositoryFilter } from './RepositoryFilter';
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Settings2,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { SecurityFinding } from '@/db/schema';

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
    exploitability?: string;
    suggestedAction?: string;
    analysisStatus?: string;
  };
  onFiltersChange: (filters: {
    status?: string;
    severity?: string;
    repoFullName?: string;
    exploitability?: string;
    suggestedAction?: string;
    analysisStatus?: string;
  }) => void;
  isEnabled: boolean;
  hasIntegration: boolean;
  onEnableClick: () => void;
  lastSyncTime?: string | null;
  onStartAnalysis?: (findingId: string) => void;
  startingAnalysisId?: string | null;
};

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
  onEnableClick,
  lastSyncTime,
  onStartAnalysis,
  startingAnalysisId,
}: SecurityFindingsCardProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);

  // Calculate closed count (fixed + ignored)
  const closedCount = stats.fixed + stats.ignored;

  const handleStatusChange = (value: string) => {
    onFiltersChange({
      ...filters,
      status: value === 'all' ? undefined : value,
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

  const handleExploitabilityChange = (value: string) => {
    onFiltersChange({
      ...filters,
      exploitability: value === 'all' ? undefined : value,
    });
    onPageChange(1);
  };

  const handleSuggestedActionChange = (value: string) => {
    onFiltersChange({
      ...filters,
      suggestedAction: value === 'all' ? undefined : value,
    });
    onPageChange(1);
  };

  const handleAnalysisStatusChange = (value: string) => {
    onFiltersChange({
      ...filters,
      analysisStatus: value === 'all' ? undefined : value,
    });
    onPageChange(1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-6">
          <button
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
        {isEnabled ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {lastSyncTime && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Clock className="h-3 w-3" />
                Last synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
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
          </div>
        ) : hasIntegration ? (
          <Button variant="outline" size="sm" onClick={onEnableClick}>
            <Settings2 className="mr-2 h-4 w-4" />
            Enable Security Reviews
          </Button>
        ) : null}
      </div>

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

        <Select value={filters.exploitability || 'all'} onValueChange={handleExploitabilityChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Exploitability" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Findings</SelectItem>
            <SelectItem value="exploitable">Exploitable</SelectItem>
            <SelectItem value="not_exploitable">Not Exploitable</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.suggestedAction || 'all'}
          onValueChange={handleSuggestedActionChange}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            <SelectItem value="dismissable">Dismissable</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.analysisStatus || 'all'} onValueChange={handleAnalysisStatusChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Analysis" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Analysis</SelectItem>
            <SelectItem value="not_analyzed">Not Analyzed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
              filters.exploitability ||
              filters.suggestedAction ||
              filters.analysisStatus) && (
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
                isStartingAnalysis={startingAnalysisId === finding.id}
              />
            ))}
          </div>
        )}
      </div>

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
