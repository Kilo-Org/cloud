'use client';

import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { AuditLogsTable } from '@/components/organizations/audit-logs/AuditLogsTable';
import {
  AuditLogsPagination,
  useAuditLogsPagination,
} from '@/components/organizations/audit-logs/AuditLogsPagination';
import { useAuditLogsFilters } from '@/components/organizations/audit-logs/useAuditLogsFilters';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';

type Props = {
  organizationId: string;
  role: OrganizationRole;
};

export function AuditLogsPage({ organizationId, role }: Props) {
  const trpc = useTRPC();
  const pagination = useAuditLogsPagination();
  const { filters, setFilter, clearFilters } = useAuditLogsFilters({
    onFiltersChange: pagination.reset,
  });
  const { assumedRole } = useRoleTesting();
  const { data: organizationData } = useOrganizationWithMembers(organizationId);

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role;

  // Check if user can view audit logs based on role testing and organization settings
  const canViewAuditLogs = currentRole === 'owner' && organizationData?.plan === 'enterprise';

  // Fetch audit logs
  const auditLogsQuery = useQuery({
    ...trpc.organizations.auditLogs.list.queryOptions({
      organizationId,
      before: pagination.currentPage.before,
      after: pagination.currentPage.after,
      action: filters.action,
      actorEmail: filters.actorEmail,
      fuzzySearch: filters.fuzzySearch,
      startTime: filters.startTime?.toISOString(),
      endTime: filters.endTime?.toISOString(),
    }),
    enabled: canViewAuditLogs,
    staleTime: 30000, // 30 seconds
  });

  // Fetch summary data for pagination info
  const summaryQuery = useQuery({
    ...trpc.organizations.auditLogs.getSummary.queryOptions({
      organizationId,
    }),
    enabled: canViewAuditLogs,
    staleTime: 60000, // 1 minute
  });

  const handleNext = () => {
    if (auditLogsQuery.data?.oldestTimestamp) {
      pagination.goNext(auditLogsQuery.data.oldestTimestamp);
    }
  };

  const handlePrevious = () => {
    pagination.goPrevious();
  };

  // Show error if user doesn't have permission
  if (!canViewAuditLogs) {
    return (
      <div className="flex w-full flex-col gap-y-6">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Audit Logs"
          showBackButton={true}
        />
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You don't have permission to view audit logs. Access is restricted based on your role
            and organization settings.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Show error if API request failed
  if (auditLogsQuery.error) {
    return (
      <div className="flex w-full flex-col gap-y-6">
        <OrganizationPageHeader organizationId={organizationId} title="Audit Logs" />
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load audit logs:{' '}
            {auditLogsQuery.error instanceof Error ? auditLogsQuery.error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-y-6">
      <OrganizationPageHeader organizationId={organizationId} title="Audit Logs" />

      {/* Summary stats */}
      {summaryQuery.data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="bg-card rounded-lg border p-4">
            <div className="text-muted-foreground text-sm">Total Events</div>
            <div className="text-2xl font-bold">
              {summaryQuery.data.totalEvents.toLocaleString()}
            </div>
          </div>

          {summaryQuery.data.earliestEvent && (
            <div className="bg-card rounded-lg border p-4">
              <div className="text-muted-foreground text-sm">Earliest Event</div>
              <div className="text-sm font-medium">
                {new Date(summaryQuery.data.earliestEvent).toLocaleDateString()}
              </div>
            </div>
          )}

          {summaryQuery.data.latestEvent && (
            <div className="bg-card rounded-lg border p-4">
              <div className="text-muted-foreground text-sm">Latest Event</div>
              <div className="text-sm font-medium">
                {new Date(summaryQuery.data.latestEvent).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audit logs table with integrated filters */}
      <AuditLogsTable
        logs={auditLogsQuery.data?.logs || []}
        isLoading={auditLogsQuery.isLoading}
        filters={filters}
        onFilterChange={setFilter}
        onClearFilters={clearFilters}
      />

      {/* Pagination */}
      {auditLogsQuery.data && auditLogsQuery.data.logs.length > 0 && (
        <AuditLogsPagination
          hasNext={auditLogsQuery.data.hasNext}
          hasPrevious={auditLogsQuery.data.hasPrevious}
          isLoading={auditLogsQuery.isLoading}
          onNext={handleNext}
          onPrevious={handlePrevious}
          currentPage={pagination.currentPageNumber}
          totalEvents={summaryQuery.data?.totalEvents}
        />
      )}
    </div>
  );
}
