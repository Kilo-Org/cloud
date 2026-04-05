'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { SecurityFindingsCard } from './SecurityFindingsCard';
import { FindingDetailDialog } from './FindingDetailDialog';
import { DismissFindingDialog, type DismissReason } from './DismissFindingDialog';
import { useSecurityAgent } from './SecurityAgentContext';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { SecurityFinding } from '@kilocode/db/schema';
import {
  SecurityFindingStatusSchema,
  SecuritySeveritySchema,
  OutcomeFilterSchema,
} from '@/lib/security-agent/core/schemas';

const PAGE_SIZE = 20;

export function SecurityFindingsPage() {
  const {
    organizationId,
    isOrg,
    hasIntegration,
    isEnabled,
    filteredRepositories,
    handleSync,
    handleDismiss,
    handleStartAnalysis,
    isSyncing,
    isDismissing,
    startingAnalysisIds,
    gitHubError,
  } = useSecurityAgent();

  const trpc = useTRPC();
  const searchParams = useSearchParams();

  // Initialize filters from URL search params.
  // When outcomeFilter implies its own status (e.g. "fixed", "dismissed"),
  // leave status unset so it doesn't contradict the outcome filter.
  const initialFilters = useMemo(() => {
    const statusParam = searchParams.get('status') ?? undefined;
    const severity = searchParams.get('severity') ?? undefined;
    const repoFullName = searchParams.get('repoFullName') ?? undefined;
    const outcomeFilter = searchParams.get('outcomeFilter') ?? undefined;
    const overdue = searchParams.get('overdue') === 'true';

    const outcomeImpliesStatus = outcomeFilter === 'fixed' || outcomeFilter === 'dismissed';

    const status = overdue ? 'open' : outcomeImpliesStatus ? undefined : (statusParam ?? 'open');

    return {
      status: status || undefined,
      severity,
      repoFullName,
      outcomeFilter,
      overdue: overdue || undefined,
    };
  }, [searchParams]);

  // Determine initial sort from overdue param
  const initialSortBy = useMemo((): 'severity_desc' | 'severity_asc' | 'sla_due_at_asc' => {
    const overdue = searchParams.get('overdue');
    return overdue === 'true' ? 'sla_due_at_asc' : 'severity_desc';
  }, [searchParams]);

  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<{
    status?: string;
    severity?: string;
    repoFullName?: string;
    outcomeFilter?: string;
    overdue?: boolean;
  }>(initialFilters);
  const [sortBy, setSortBy] = useState<'severity_desc' | 'severity_asc' | 'sla_due_at_asc'>(
    initialSortBy
  );
  const [selectedFinding, setSelectedFinding] = useState<SecurityFinding | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);

  // Fetch a specific finding by ID for deep-link support, so the dialog opens
  // even when the finding isn't on the current page.
  const findingIdParam = searchParams.get('findingId');
  const { data: deepLinkedFinding } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getFinding.queryOptions({
          organizationId: organizationId ?? '',
          id: findingIdParam ?? '',
        })
      : trpc.securityAgent.getFinding.queryOptions({
          id: findingIdParam ?? '',
        })),
    enabled: !!findingIdParam,
  });

  const handleSortByChange = useCallback(
    (newSortBy: 'severity_desc' | 'severity_asc' | 'sla_due_at_asc') => {
      setSortBy(newSortBy);
      setPage(1);
    },
    []
  );

  // Build query params
  const findingsQueryParams = useMemo(() => {
    const parsedStatus = SecurityFindingStatusSchema.safeParse(filters.status);
    const parsedSeverity = SecuritySeveritySchema.safeParse(filters.severity);
    const parsedOutcome = OutcomeFilterSchema.safeParse(filters.outcomeFilter);
    return {
      status: parsedStatus.success ? parsedStatus.data : undefined,
      severity: parsedSeverity.success ? parsedSeverity.data : undefined,
      outcomeFilter: parsedOutcome.success ? parsedOutcome.data : undefined,
      overdue: filters.overdue,
      sortBy,
      repoFullName: filters.repoFullName,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
  }, [filters, sortBy, page]);

  // Findings query
  const { data: findingsData, isLoading: isLoadingFindings } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.listFindings.queryOptions({
          organizationId: organizationId ?? '',
          ...findingsQueryParams,
        })
      : trpc.securityAgent.listFindings.queryOptions(findingsQueryParams)),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result) return false;
      const hasActiveAnalysis =
        (result.runningCount ?? 0) > 0 ||
        result.findings.some(
          f => f.analysis_status === 'pending' || f.analysis_status === 'running'
        );
      return hasActiveAnalysis ? 5000 : false;
    },
  });

  // Stats query
  const { data: statsData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getStats.queryOptions({
          organizationId: organizationId ?? '',
        })
      : trpc.securityAgent.getStats.queryOptions()
  );

  // Last sync time query
  const { data: lastSyncData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName: filters.repoFullName,
        })
      : trpc.securityAgent.getLastSyncTime.queryOptions({
          repoFullName: filters.repoFullName,
        })
  );

  const findings = findingsData?.findings ?? [];
  const totalCount = findingsData?.totalCount ?? 0;
  const serverRunningCount = findingsData?.runningCount ?? 0;
  const concurrencyLimit = findingsData?.concurrencyLimit ?? 3;

  // Count how many IDs the user just clicked "Analyze" on that haven't yet
  // transitioned to pending/running *on the current page*.  IDs that aren't
  // visible on this page are already included in serverRunningCount (which is
  // global), so we must NOT add them again — that would double-count.
  const runningCount = useMemo(() => {
    if (startingAnalysisIds.size === 0) return serverRunningCount;
    let optimisticAdditional = 0;
    for (const id of startingAnalysisIds) {
      const finding = findings.find(f => f.id === id);
      // Only add optimistic count for findings visible on this page whose
      // server status hasn't caught up yet.  Off-page findings are already
      // reflected in serverRunningCount.
      if (
        finding &&
        finding.analysis_status !== 'pending' &&
        finding.analysis_status !== 'running'
      ) {
        optimisticAdditional++;
      }
    }
    return serverRunningCount + optimisticAdditional;
  }, [serverRunningCount, startingAnalysisIds, findings]);

  const stats = statsData ?? {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    open: 0,
    fixed: 0,
    ignored: 0,
  };

  // Handle finding click
  const handleFindingClick = useCallback((finding: SecurityFinding) => {
    setSelectedFinding(finding);
    setDetailDialogOpen(true);
  }, []);

  // Auto-open finding from URL param using the dedicated query
  useEffect(() => {
    if (deepLinkedFinding && !selectedFinding) {
      setSelectedFinding(deepLinkedFinding);
      setDetailDialogOpen(true);
    }
  }, [deepLinkedFinding, selectedFinding]);

  const handleOpenDismissDialog = useCallback(() => {
    setDetailDialogOpen(false);
    setDismissDialogOpen(true);
  }, []);

  // Track whether we've submitted a dismiss so we can close the dialog when the
  // mutation settles (success or failure), rather than closing eagerly and losing
  // the user's reason/comment on failure.
  const dismissSubmittedRef = useRef(false);

  const handleDismissSubmit = useCallback(
    (reason: DismissReason, comment?: string) => {
      if (!selectedFinding) return;
      dismissSubmittedRef.current = true;
      handleDismiss(selectedFinding, reason, comment);
    },
    [selectedFinding, handleDismiss]
  );

  // Close dismiss dialog after the mutation finishes (isDismissing: true → false).
  useEffect(() => {
    if (!isDismissing && dismissSubmittedRef.current) {
      dismissSubmittedRef.current = false;
      setDismissDialogOpen(false);
      setDetailDialogOpen(false);
      setSelectedFinding(null);
    }
  }, [isDismissing]);

  const handleEnableClick = useCallback(() => {
    const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';
    window.location.href = `${basePath}/config`;
  }, [isOrg, organizationId]);

  const installUrl = isOrg
    ? `/organizations/${organizationId}/integrations`
    : '/integrations/github';

  return (
    <>
      {/* GitHub Integration Error Alert */}
      {gitHubError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>GitHub Integration Error</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Failed to access GitHub: {gitHubError}</p>
            <p className="text-sm">
              This usually happens when the GitHub App has been uninstalled or permissions have
              changed. Please reinstall the GitHub App to continue running security analyses.
            </p>
            <Link href={isOrg ? `/organizations/${organizationId}/integrations` : '/integrations'}>
              <Button variant="outline" size="sm">
                Go to Integrations
                <ExternalLink className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <SecurityFindingsCard
        findings={findings}
        repositories={filteredRepositories}
        stats={stats}
        totalCount={totalCount}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        onFindingClick={handleFindingClick}
        onSync={handleSync}
        isSyncing={isSyncing}
        isLoading={isLoadingFindings}
        filters={filters}
        onFiltersChange={setFilters}
        isEnabled={isEnabled ?? false}
        hasIntegration={hasIntegration}
        installUrl={installUrl}
        onEnableClick={handleEnableClick}
        lastSyncTime={lastSyncData?.lastSyncTime}
        onStartAnalysis={handleStartAnalysis}
        startingAnalysisIds={startingAnalysisIds}
        sortBy={sortBy}
        onSortByChange={handleSortByChange}
        runningCount={runningCount}
        concurrencyLimit={concurrencyLimit}
      />

      <FindingDetailDialog
        finding={selectedFinding}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        onDismiss={handleOpenDismissDialog}
        canDismiss={selectedFinding?.status === 'open'}
        organizationId={organizationId}
      />

      <DismissFindingDialog
        finding={selectedFinding}
        open={dismissDialogOpen}
        onOpenChange={setDismissDialogOpen}
        onDismiss={handleDismissSubmit}
        isLoading={isDismissing}
      />
    </>
  );
}
