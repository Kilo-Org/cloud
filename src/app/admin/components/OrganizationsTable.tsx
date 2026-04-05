'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Table } from '@/components/ui/table';
import { OrganizationTableHeader } from './OrganizationTableHeader';
import { OrganizationTableBody } from './OrganizationTableBody';
import { OrganizationTablePagination } from './OrganizationTablePagination';
import { OrganizationFilters } from './OrganizationFilters';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';
import { OrganizationMetricCards } from './OrganizationMetricCards';
import { useOrganizationsList } from '@/app/admin/api/organizations/hooks';
import type { OrganizationSortableField } from '@/types/admin';
import type { PageSize } from '@/types/pagination';
import AdminPage from '@/app/admin/components/AdminPage';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

type OrganizationSortConfig = {
  field: OrganizationSortableField;
  direction: 'asc' | 'desc';
};

export function OrganizationsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const currentPage = parseInt(searchParams.get('page') || '1');
  const currentPageSize = parseInt(searchParams.get('limit') || '25') as PageSize;
  const currentSortBy = (searchParams.get('sortBy') || 'created_at') as OrganizationSortableField;
  const currentSortOrder = searchParams.get('sortOrder') || 'desc';
  const currentSearch = searchParams.get('search') || '';
  const currentSeatsRequired = searchParams.get('seatsRequired') || '';
  const currentHasBalance = searchParams.get('hasBalance') || '';
  const currentStatus = searchParams.get('status') || 'all';
  const currentPlan = searchParams.get('plan') || '';

  const sortConfig: OrganizationSortConfig = useMemo(
    () => ({
      field: currentSortBy,
      direction: currentSortOrder as 'asc' | 'desc',
    }),
    [currentSortBy, currentSortOrder]
  );

  const { data, isLoading, isFetching } = useOrganizationsList({
    page: currentPage,
    limit: currentPageSize,
    sortBy: currentSortBy,
    sortOrder: currentSortOrder as 'asc' | 'desc',
    search: currentSearch,
    seatsRequired: currentSeatsRequired,
    hasBalance: currentHasBalance,
    status: currentStatus,
    plan: currentPlan,
  });

  const updateUrl = useCallback(
    (params: Record<string, string>) => {
      const newSearchParams = new URLSearchParams(searchParams.toString());

      Object.entries(params).forEach(([key, value]) => {
        if (value) {
          newSearchParams.set(key, value);
        } else {
          newSearchParams.delete(key);
        }
      });

      router.push(`/admin/organizations?${newSearchParams.toString()}`);
    },
    [router, searchParams]
  );

  const handleSearchChange = useCallback(
    (searchTerm: string) => {
      const params = {
        search: searchTerm,
        page: '1', // Reset to first page when searching
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentSeatsRequired,
      currentHasBalance,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  const handleSeatsRequiredChange = useCallback(
    (value: string) => {
      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when filtering
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: value,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentSearch,
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentHasBalance,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  const handleHasBalanceChange = useCallback(
    (value: string) => {
      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when filtering
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: value,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentSearch,
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentSeatsRequired,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  const handleStatusChange = useCallback(
    (value: string) => {
      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when filtering
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: value === 'all' ? '' : value,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentSearch,
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentSeatsRequired,
      currentHasBalance,
      currentPlan,
      updateUrl,
    ]
  );

  const handlePlanChange = useCallback(
    (value: string) => {
      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when filtering
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: value === 'all' ? '' : value,
      };

      updateUrl(params);
    },
    [
      currentSearch,
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentSeatsRequired,
      currentHasBalance,
      currentStatus,
      updateUrl,
    ]
  );

  const handleResetFilters = useCallback(() => {
    const params = {
      search: currentSearch,
      page: '1',
      limit: currentPageSize.toString(),
      sortBy: currentSortBy,
      sortOrder: currentSortOrder,
      seatsRequired: '',
      hasBalance: '',
      status: '',
      plan: '',
    };

    updateUrl(params);
  }, [currentSearch, currentPageSize, currentSortBy, currentSortOrder, updateUrl]);

  // Handle sorting
  const handleSort = useCallback(
    (field: OrganizationSortableField) => {
      const newDirection =
        sortConfig.field === field && sortConfig.direction === 'asc' ? 'desc' : 'asc';

      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when sorting
        limit: currentPageSize.toString(),
        sortBy: field,
        sortOrder: newDirection,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      sortConfig,
      currentPageSize,
      currentSearch,
      currentSeatsRequired,
      currentHasBalance,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  // Handle page change
  const handlePageChange = useCallback(
    (page: number) => {
      const params = {
        search: currentSearch,
        page: page.toString(),
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentSearch,
      currentSeatsRequired,
      currentHasBalance,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  const handlePageSizeChange = useCallback(
    (pageSize: PageSize) => {
      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when changing page size
        limit: pageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
        seatsRequired: currentSeatsRequired,
        hasBalance: currentHasBalance,
        status: currentStatus === 'all' ? '' : currentStatus,
        plan: currentPlan === 'all' ? '' : currentPlan,
      };

      updateUrl(params);
    },
    [
      currentSortBy,
      currentSortOrder,
      currentSearch,
      currentSeatsRequired,
      currentHasBalance,
      currentStatus,
      currentPlan,
      updateUrl,
    ]
  );

  const buttons = (
    <>
      <Button variant="outline" onClick={() => setIsCreateDialogOpen(true)}>
        {' '}
        <Plus className="h-4 w-4" />
        Create Organization
      </Button>{' '}
    </>
  );

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbPage>Organizations</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs} buttons={buttons}>
      <div className="flex max-w-max flex-col gap-y-4">
        {/* Organization Metrics */}
        <OrganizationMetricCards />

        <div className="flex items-center justify-between">
          <OrganizationFilters
            search={currentSearch}
            onSearchChange={handleSearchChange}
            isLoading={isFetching}
            seatsRequired={currentSeatsRequired}
            hasBalance={currentHasBalance}
            status={currentStatus}
            plan={currentPlan}
            onSeatsRequiredChange={handleSeatsRequiredChange}
            onHasBalanceChange={handleHasBalanceChange}
            onStatusChange={handleStatusChange}
            onPlanChange={handlePlanChange}
            onResetFilters={handleResetFilters}
            totalCount={data?.pagination.total}
            filteredCount={data?.pagination.total}
          />
        </div>

        <div className="rounded-lg border">
          <Table>
            <OrganizationTableHeader
              sortConfig={sortConfig}
              onSort={handleSort}
              showDeleted={currentStatus === 'deleted' || currentStatus === 'all'}
            />
            <OrganizationTableBody
              organizations={data?.organizations || []}
              isLoading={isLoading}
              searchTerm={currentSearch}
              showDeleted={currentStatus === 'deleted' || currentStatus === 'all'}
            />
          </Table>
        </div>

        <div className="mt-4">
          <OrganizationTablePagination
            pagination={
              data?.pagination || {
                page: 1,
                total: 0,
                totalPages: 1,
                limit: currentPageSize,
              }
            }
            pageSize={currentPageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            isLoading={isLoading}
          />
        </div>

        <CreateOrganizationDialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen} />
      </div>
    </AdminPage>
  );
}
