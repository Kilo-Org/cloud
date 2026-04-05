'use client';

import { useState } from 'react';
import { useSecurityAgent } from './SecurityAgentContext';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Shield, RefreshCw, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { RepositoryFilter } from './RepositoryFilter';
import { SlaComplianceHero } from './dashboard/SlaComplianceHero';
import { SeverityBreakdown } from './dashboard/SeverityBreakdown';
import { StatusOverview } from './dashboard/StatusOverview';
import { AnalysisCoverage } from './dashboard/AnalysisCoverage';
import { MeanTimeToResolution } from './dashboard/MeanTimeToResolution';
import { OverdueFindingsTable } from './dashboard/OverdueFindingsTable';
import { RepositoryHealthTable } from './dashboard/RepositoryHealthTable';

const emptySla = {
  overall: { total: 0, withinSla: 0, overdue: 0 },
  bySeverity: {
    critical: { total: 0, withinSla: 0, overdue: 0 },
    high: { total: 0, withinSla: 0, overdue: 0 },
    medium: { total: 0, withinSla: 0, overdue: 0 },
    low: { total: 0, withinSla: 0, overdue: 0 },
  },
  untrackedCount: 0,
};

const emptySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

const emptyStatus = { open: 0, fixed: 0, ignored: 0 };

const emptyAnalysis = {
  total: 0,
  analyzed: 0,
  exploitable: 0,
  notExploitable: 0,
  triageComplete: 0,
  safeToDismiss: 0,
  needsReview: 0,
  analyzing: 0,
  notAnalyzed: 0,
  failed: 0,
};

const emptyMttr = {
  bySeverity: {
    critical: { avgDays: null, medianDays: null, count: 0, slaDays: 15 },
    high: { avgDays: null, medianDays: null, count: 0, slaDays: 30 },
    medium: { avgDays: null, medianDays: null, count: 0, slaDays: 45 },
    low: { avgDays: null, medianDays: null, count: 0, slaDays: 90 },
  },
};

export function SecurityDashboard() {
  const {
    hasIntegration,
    isLoadingPermission,
    isOrg,
    organizationId,
    filteredRepositories,
    handleSync,
    isSyncing,
  } = useSecurityAgent();
  const trpc = useTRPC();
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);

  const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';

  // Build a query string suffix for drill-down links so the selected repo filter carries through
  const repoFilterParam = repoFullName ? `&repoFullName=${encodeURIComponent(repoFullName)}` : '';

  const { data, isLoading } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getDashboardStats.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName,
        })
      : trpc.securityAgent.getDashboardStats.queryOptions({
          repoFullName,
        })),
    staleTime: 30_000,
    enabled: hasIntegration,
  });

  // Use real sync time from DB rather than React Query fetch time
  const { data: lastSyncData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName,
        })
      : trpc.securityAgent.getLastSyncTime.queryOptions({
          repoFullName,
        })
  );

  if (isLoadingPermission) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!hasIntegration) {
    const installUrl = isOrg
      ? `/organizations/${organizationId}/integrations`
      : '/integrations/github';
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-700 py-16">
        <Shield className="text-muted-foreground mb-4 h-12 w-12 opacity-40" />
        <h3 className="text-lg font-medium">Connect GitHub to get started</h3>
        <p className="text-muted-foreground mt-2 max-w-md text-center text-sm">
          Install the Kilo GitHub App to automatically sync Dependabot alerts and manage security
          findings across your repositories.
        </p>
        <Button asChild className="mt-6">
          <Link href={installUrl}>Install GitHub App</Link>
        </Button>
      </div>
    );
  }

  const sla = data?.sla ?? emptySla;
  const severity = data?.severity ?? emptySeverity;
  const status = data?.status ?? emptyStatus;
  const analysis = data?.analysis ?? emptyAnalysis;
  const mttr = data?.mttr ?? emptyMttr;
  const overdue = data?.overdue ?? [];
  const repoHealth = data?.repoHealth ?? [];

  const lastSyncTime = lastSyncData?.lastSyncTime;
  const lastUpdated = lastSyncTime
    ? `Last synced ${formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}`
    : null;

  return (
    <div className="space-y-6">
      {/* Header: filters and actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RepositoryFilter
          repositories={filteredRepositories}
          value={repoFullName}
          onValueChange={setRepoFullName}
          isLoading={isLoading}
        />
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-muted-foreground text-xs">{lastUpdated}</span>}
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              handleSync(repoFullName);
            }}
            disabled={isSyncing || isLoading}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* SLA Compliance Hero */}
      <SlaComplianceHero
        sla={sla}
        isLoading={isLoading}
        basePath={basePath}
        extraParams={repoFilterParam}
      />

      {/* Severity Breakdown + Status Overview */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SeverityBreakdown
          severity={severity}
          isLoading={isLoading}
          basePath={basePath}
          extraParams={repoFilterParam}
        />
        <StatusOverview
          status={status}
          isLoading={isLoading}
          basePath={basePath}
          extraParams={repoFilterParam}
        />
      </div>

      {/* Analysis Coverage + MTTR */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AnalysisCoverage
          analysis={analysis}
          isLoading={isLoading}
          basePath={basePath}
          extraParams={repoFilterParam}
        />
        <MeanTimeToResolution mttr={mttr} isLoading={isLoading} />
      </div>

      {/* Overdue Findings */}
      <OverdueFindingsTable
        findings={overdue}
        isLoading={isLoading}
        basePath={basePath}
        extraParams={repoFilterParam}
      />

      {/* Repository Health */}
      <RepositoryHealthTable
        repos={repoHealth}
        isLoading={isLoading}
        basePath={basePath}
        extraParams={repoFilterParam}
      />
    </div>
  );
}
