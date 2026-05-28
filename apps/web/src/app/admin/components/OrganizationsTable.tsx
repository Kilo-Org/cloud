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

type OrganizationsTableProps = {
  mode?: 'paying' | 'trial' | 'all';
  showMetrics?: boolean;
  showStripeStatus?: boolean;
};

export function OrganizationsTable({
  mode = 'paying',
  showMetrics = true,
  showStripeStatus = true,
}: OrganizationsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const currentPage = parseInt(searchParams.get('page') || '1');
  const currentPageSize = parseInt(searchParams.get('limit') || '25') as PageSize;
  const currentSortBy = (searchParams.get('sortBy') || 'name') as OrganizationSortableField;
  const currentSortOrder = searchParams.get('sortOrder') || 'desc';
  const currentSearch = searchParams.get('search') || '';
  const currentIncludeDeleted = searchParams.get('include_deleted') === 'true';
  const currentStripeStatus = searchParams.get('stripe_status') || '';
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
    mode,
    include_deleted: currentIncludeDeleted,
    stripe_status: currentStripeStatus,
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

      router.push(`?${newSearchParams.toString()}`);
    },
    [router, searchParams]
  );

  const sharedParams = useCallback(
    () => ({
      limit: currentPageSize.toString(),
      sortBy: currentSortBy,
      sortOrder: currentSortOrder,
      include_deleted: currentIncludeDeleted ? 'true' : '',
      stripe_status: currentStripeStatus,
      plan: currentPlan === 'all' ? '' : currentPlan,
    }),
    [
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentIncludeDeleted,
      currentStripeStatus,
      currentPlan,
    ]
  );

  const handleSearchChange = useCallback(
    (searchTerm: string) => {
      updateUrl({ ...sharedParams(), search: searchTerm, page: '1' });
    },
    [sharedParams, updateUrl]
  );

  const handleIncludeDeletedChange = useCallback(
    (value: boolean) => {
      updateUrl({
        ...sharedParams(),
        include_deleted: value ? 'true' : '',
        search: currentSearch,
        page: '1',
      });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handleStripeStatusChange = useCallback(
    (value: string) => {
      updateUrl({ ...sharedParams(), stripe_status: value, search: currentSearch, page: '1' });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handlePlanChange = useCallback(
    (value: string) => {
      updateUrl({
        ...sharedParams(),
        plan: value === 'all' ? '' : value,
        search: currentSearch,
        page: '1',
      });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handleResetFilters = useCallback(() => {
    updateUrl({
      search: currentSearch,
      page: '1',
      limit: currentPageSize.toString(),
      sortBy: currentSortBy,
      sortOrder: currentSortOrder,
      include_deleted: '',
      stripe_status: '',
      plan: '',
    });
  }, [currentSearch, currentPageSize, currentSortBy, currentSortOrder, updateUrl]);

  const handleSort = useCallback(
    (field: OrganizationSortableField) => {
      const newDirection =
        sortConfig.field === field && sortConfig.direction === 'asc' ? 'desc' : 'asc';
      updateUrl({
        ...sharedParams(),
        search: currentSearch,
        page: '1',
        sortBy: field,
        sortOrder: newDirection,
      });
    },
    [sortConfig, sharedParams, currentSearch, updateUrl]
  );

  const handlePageChange = useCallback(
    (page: number) => {
      updateUrl({ ...sharedParams(), search: currentSearch, page: page.toString() });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handlePageSizeChange = useCallback(
    (pageSize: PageSize) => {
      updateUrl({
        ...sharedParams(),
        search: currentSearch,
        page: '1',
        limit: pageSize.toString(),
      });
    },
    [sharedParams, currentSearch, updateUrl]
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
        {showMetrics && <OrganizationMetricCards />}

        <div className="flex items-center justify-between">
          <OrganizationFilters
            search={currentSearch}
            onSearchChange={handleSearchChange}
            isLoading={isFetching}
            includeDeleted={currentIncludeDeleted}
            stripeStatus={currentStripeStatus}
            plan={currentPlan}
            showStripeStatus={showStripeStatus}
            onIncludeDeletedChange={handleIncludeDeletedChange}
            onStripeStatusChange={handleStripeStatusChange}
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
              showDeleted={currentIncludeDeleted}
            />
            <OrganizationTableBody
              organizations={data?.organizations || []}
              isLoading={isLoading}
              searchTerm={currentSearch}
              showDeleted={currentIncludeDeleted}
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
