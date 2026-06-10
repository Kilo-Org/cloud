'use client';

import { useReducer } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { SecurityFinding } from '@kilocode/db/schema';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';
import {
  OutcomeFilterSchema,
  SecurityFindingStatusSchema,
  SecuritySeveritySchema,
} from '@/lib/security-agent/core/schemas';
import { DismissFindingDialog, type DismissReason } from './DismissFindingDialog';
import { FindingDetailDialog } from './FindingDetailDialog';
import { SecurityFindingsCard } from './SecurityFindingsCard';
import { useSecurityAgent } from './SecurityAgentContext';

const PAGE_SIZE = 20;
const EMPTY_FINDINGS: SecurityFinding[] = [];

type Filters = {
  status?: string;
  severity?: string;
  repoFullName?: string;
  outcomeFilter?: string;
  overdue?: boolean;
};

type SortBy = 'severity_desc' | 'severity_asc' | 'sla_due_at_asc';

type PageState = {
  page: number;
  filters: Filters;
  sortBy: SortBy;
  selectedFinding: SecurityFinding | null;
  detailDialogOpen: boolean;
  dismissDialogOpen: boolean;
  closedDeepLinkId: string | null;
};

type PageAction =
  | { type: 'set-page'; page: number }
  | { type: 'set-filters'; filters: Filters }
  | { type: 'set-sort'; sortBy: SortBy }
  | { type: 'open-detail'; finding: SecurityFinding }
  | { type: 'set-detail-open'; open: boolean }
  | { type: 'open-dismiss'; finding: SecurityFinding }
  | { type: 'set-dismiss-open'; open: boolean }
  | { type: 'close-deep-link'; findingId: string }
  | { type: 'finish-dismiss' };

type SearchParamsReader = {
  get: (name: string) => string | null;
};

function createInitialPageState(searchParams: SearchParamsReader): PageState {
  const statusParam = searchParams.get('status') ?? undefined;
  const outcomeFilter = searchParams.get('outcomeFilter') ?? undefined;
  const overdue = searchParams.get('overdue') === 'true';
  const outcomeImpliesStatus = outcomeFilter === 'fixed' || outcomeFilter === 'dismissed';

  return {
    page: 1,
    filters: {
      status: overdue ? 'open' : outcomeImpliesStatus ? undefined : (statusParam ?? 'open'),
      severity: searchParams.get('severity') ?? undefined,
      repoFullName: searchParams.get('repoFullName') ?? undefined,
      outcomeFilter,
      overdue: overdue || undefined,
    },
    sortBy: overdue ? 'sla_due_at_asc' : 'severity_desc',
    selectedFinding: null,
    detailDialogOpen: false,
    dismissDialogOpen: false,
    closedDeepLinkId: null,
  };
}

function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case 'set-page':
      return { ...state, page: action.page };
    case 'set-filters':
      return { ...state, filters: action.filters, page: 1 };
    case 'set-sort':
      return { ...state, sortBy: action.sortBy, page: 1 };
    case 'open-detail':
      return { ...state, selectedFinding: action.finding, detailDialogOpen: true };
    case 'set-detail-open':
      return {
        ...state,
        detailDialogOpen: action.open,
        selectedFinding: action.open ? state.selectedFinding : null,
      };
    case 'open-dismiss':
      return {
        ...state,
        selectedFinding: action.finding,
        detailDialogOpen: false,
        dismissDialogOpen: true,
      };
    case 'set-dismiss-open':
      return {
        ...state,
        dismissDialogOpen: action.open,
        selectedFinding: action.open ? state.selectedFinding : null,
      };
    case 'close-deep-link':
      return { ...state, closedDeepLinkId: action.findingId };
    case 'finish-dismiss':
      return {
        ...state,
        selectedFinding: null,
        detailDialogOpen: false,
        dismissDialogOpen: false,
      };
  }
}

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, dispatch] = useReducer(pageReducer, searchParams, createInitialPageState);

  const findingIdParam = searchParams.get('findingId');
  const { data: deepLinkedFinding } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getFinding.queryOptions({
          organizationId: organizationId ?? '',
          id: findingIdParam ?? '',
        })
      : trpc.securityAgent.getFinding.queryOptions({ id: findingIdParam ?? '' })),
    enabled: Boolean(findingIdParam),
  });

  const parsedStatus = SecurityFindingStatusSchema.safeParse(state.filters.status);
  const parsedSeverity = SecuritySeveritySchema.safeParse(state.filters.severity);
  const parsedOutcome = OutcomeFilterSchema.safeParse(state.filters.outcomeFilter);
  const findingsQueryParams = {
    status: parsedStatus.success ? parsedStatus.data : undefined,
    severity: parsedSeverity.success ? parsedSeverity.data : undefined,
    outcomeFilter: parsedOutcome.success ? parsedOutcome.data : undefined,
    overdue: state.filters.overdue,
    sortBy: state.sortBy,
    repoFullName: state.filters.repoFullName,
    limit: PAGE_SIZE,
    offset: (state.page - 1) * PAGE_SIZE,
  };

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
          finding => finding.analysis_status === 'pending' || finding.analysis_status === 'running'
        );
      return hasActiveAnalysis ? 5000 : false;
    },
  });

  const { data: statsData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getStats.queryOptions({
          organizationId: organizationId ?? '',
        })
      : trpc.securityAgent.getStats.queryOptions()
  );
  const { data: lastSyncData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName: state.filters.repoFullName,
        })
      : trpc.securityAgent.getLastSyncTime.queryOptions({
          repoFullName: state.filters.repoFullName,
        })
  );

  const findings = findingsData?.findings ?? EMPTY_FINDINGS;
  const findingsById = new Map(findings.map(finding => [finding.id, finding]));
  const serverRunningCount = findingsData?.runningCount ?? 0;
  let optimisticAdditional = 0;
  for (const id of startingAnalysisIds) {
    const finding = findingsById.get(id);
    if (finding && finding.analysis_status !== 'pending' && finding.analysis_status !== 'running') {
      optimisticAdditional += 1;
    }
  }
  const runningCount = serverRunningCount + optimisticAdditional;

  const deepLinkIsOpen = Boolean(
    deepLinkedFinding && !state.selectedFinding && state.closedDeepLinkId !== deepLinkedFinding.id
  );
  const activeFinding =
    state.selectedFinding ?? (deepLinkIsOpen ? (deepLinkedFinding ?? null) : null);
  const detailDialogOpen = state.detailDialogOpen || deepLinkIsOpen;

  const handleDetailOpenChange = (open: boolean) => {
    if (!open && deepLinkIsOpen && deepLinkedFinding) {
      dispatch({ type: 'close-deep-link', findingId: deepLinkedFinding.id });
      return;
    }
    dispatch({ type: 'set-detail-open', open });
  };

  const handleDismissSubmit = (reason: DismissReason, comment?: string) => {
    if (!activeFinding) return;
    handleDismiss(activeFinding, reason, comment, () => dispatch({ type: 'finish-dismiss' }));
  };

  const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';
  const installUrl = isOrg
    ? `/organizations/${organizationId}/integrations`
    : '/integrations/github';
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

  return (
    <>
      {gitHubError && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <AlertTitle>GitHub integration error</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Security Agent cannot access GitHub. {gitHubError}</p>
            <p className="text-sm">
              Check GitHub App installation and repository permissions, then retry.
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link
                href={isOrg ? `/organizations/${organizationId}/integrations` : '/integrations'}
              >
                View integrations
                <ExternalLink className="ml-2 size-3" aria-hidden="true" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <SecurityFindingsCard
        findings={findings}
        repositories={filteredRepositories}
        stats={stats}
        totalCount={findingsData?.totalCount ?? 0}
        page={state.page}
        pageSize={PAGE_SIZE}
        onPageChange={page => dispatch({ type: 'set-page', page })}
        onFindingClick={finding => dispatch({ type: 'open-detail', finding })}
        onSync={handleSync}
        state={{
          isSyncing,
          isLoading: isLoadingFindings,
          isEnabled: isEnabled ?? false,
          hasIntegration,
        }}
        filters={state.filters}
        onFiltersChange={filters => dispatch({ type: 'set-filters', filters })}
        installUrl={installUrl}
        onEnableClick={() => router.push(`${basePath}/config`)}
        lastSyncTime={lastSyncData?.lastSyncTime}
        onStartAnalysis={handleStartAnalysis}
        startingAnalysisIds={startingAnalysisIds}
        sortBy={state.sortBy}
        onSortByChange={sortBy => dispatch({ type: 'set-sort', sortBy })}
        runningCount={runningCount}
        concurrencyLimit={findingsData?.concurrencyLimit ?? 3}
      />

      <FindingDetailDialog
        finding={activeFinding}
        open={detailDialogOpen}
        onOpenChange={handleDetailOpenChange}
        onDismiss={() => {
          if (activeFinding) dispatch({ type: 'open-dismiss', finding: activeFinding });
        }}
        canDismiss={activeFinding?.status === 'open'}
        organizationId={organizationId}
      />

      <DismissFindingDialog
        finding={state.selectedFinding}
        open={state.dismissDialogOpen}
        onOpenChange={open => dispatch({ type: 'set-dismiss-open', open })}
        onDismiss={handleDismissSubmit}
        isLoading={isDismissing}
      />
    </>
  );
}
