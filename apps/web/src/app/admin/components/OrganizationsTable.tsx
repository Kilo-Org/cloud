'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Table } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { OrganizationTableHeader } from './OrganizationTableHeader';
import { OrganizationTableBody } from './OrganizationTableBody';
import { OrganizationTablePagination } from './OrganizationTablePagination';
import { OrganizationFilters } from './OrganizationFilters';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';
import { OrganizationMetricCards } from './OrganizationMetricCards';
import { useOrganizationsList } from '@/app/admin/api/organizations/hooks';
import type { OrganizationSortableField } from '@/types/admin';
import type { PageSize } from '@/types/pagination';
import type { TableVariant } from './OrganizationTableHeader';
import AdminPage from '@/app/admin/components/AdminPage';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

type OrganizationSortConfig = {
  field: OrganizationSortableField;
  direction: 'asc' | 'desc';
};

// `create` is required only when the page wants the create button rendered;
// callers that omit `create` get no button. This avoids a never-rendered default
// label and keeps the create-button-label and click-target wired together.
type CreateButtonConfig = {
  label: string;
};

type OrganizationsTableProps = {
  mode?: 'paying' | 'trial' | 'all';
  showMetrics?: boolean;
  showStripeStatus?: boolean;
  pageTitle?: string;
  create?: CreateButtonConfig;
  defaultTab?: TableVariant;
  // Trial-specific surfaces: extra column + extra filters. When `showTrialFilters`
  // is true, the `has_usage` and `has_multiple_users` filters default to ON
  // (admins typically want trials worth investigating); explicit URL params
  // override.
  showTrialEndDate?: boolean;
  showTrialFilters?: boolean;
  // Default Stripe-status filter applied when the URL has no `stripe_status`
  // param at all. The user can clear it to "Any" via the filter dropdown,
  // which sets `stripe_status=any` in the URL so the default no longer kicks
  // in on refresh.
  defaultStripeStatus?: string;
};

const ANY_STRIPE_STATUS_TOKEN = 'any';

export function OrganizationsTable({
  mode = 'paying',
  showMetrics = true,
  showStripeStatus = true,
  pageTitle = 'Organizations',
  create,
  defaultTab = 'entitlements',
  showTrialEndDate = false,
  showTrialFilters = false,
  defaultStripeStatus,
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
  // Stripe status: an absent param falls back to the page-level default (e.g.
  // 'active' on /admin/organizations). The user clears the filter to "Any" by
  // writing the sentinel `stripe_status=any` to the URL so the default no
  // longer kicks in on refresh.
  const rawStripeStatus = searchParams.get('stripe_status');
  const currentStripeStatus =
    rawStripeStatus === null
      ? (defaultStripeStatus ?? '')
      : rawStripeStatus === ANY_STRIPE_STATUS_TOKEN
        ? ''
        : rawStripeStatus;
  const currentPlan = searchParams.get('plan') || '';
  const currentTab = (searchParams.get('tab') || defaultTab) as TableVariant;

  // When trial filters are surfaced, default both checkboxes to true. We
  // distinguish "absent" from "explicitly off" by reading the raw param: an
  // empty/missing param means "use the default", and 'false' means "explicitly
  // unchecked". Trial filters do nothing when `showTrialFilters` is false.
  const rawHasUsage = searchParams.get('has_usage');
  const rawHasMultipleUsers = searchParams.get('has_multiple_users');
  const currentHasUsage = showTrialFilters
    ? rawHasUsage === null
      ? true
      : rawHasUsage === 'true'
    : false;
  const currentHasMultipleUsers = showTrialFilters
    ? rawHasMultipleUsers === null
      ? true
      : rawHasMultipleUsers === 'true'
    : false;

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
    has_usage: currentHasUsage,
    has_multiple_users: currentHasMultipleUsers,
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
      // Preserve the raw URL value so the page-level default + the user's
      // explicit "Any" sentinel both survive across sort/page/search changes.
      stripe_status: rawStripeStatus ?? '',
      plan: currentPlan === 'all' ? '' : currentPlan,
      tab: currentTab,
      // Preserve whatever's currently in the URL. `has_usage`/`has_multiple_users`
      // can be absent (= default true on trials), or explicitly 'true' / 'false'.
      has_usage: rawHasUsage ?? '',
      has_multiple_users: rawHasMultipleUsers ?? '',
    }),
    [
      currentPageSize,
      currentSortBy,
      currentSortOrder,
      currentIncludeDeleted,
      rawStripeStatus,
      currentPlan,
      currentTab,
      rawHasUsage,
      rawHasMultipleUsers,
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
      // Write the sentinel for an explicit "Any" choice so a page-level default
      // (e.g. 'active' on /admin/organizations) doesn't re-apply on refresh.
      const next = value === '' ? ANY_STRIPE_STATUS_TOKEN : value;
      updateUrl({ ...sharedParams(), stripe_status: next, search: currentSearch, page: '1' });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handleHasUsageChange = useCallback(
    (value: boolean) => {
      updateUrl({
        ...sharedParams(),
        // Always set explicitly so the user's choice is sticky (the default-true
        // semantics only apply when the param is entirely absent).
        has_usage: value ? 'true' : 'false',
        search: currentSearch,
        page: '1',
      });
    },
    [sharedParams, currentSearch, updateUrl]
  );

  const handleHasMultipleUsersChange = useCallback(
    (value: boolean) => {
      updateUrl({
        ...sharedParams(),
        has_multiple_users: value ? 'true' : 'false',
        search: currentSearch,
        page: '1',
      });
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
      // Clearing returns the trial filters to their default-true state on the
      // trials page (and to inert/false elsewhere).
      has_usage: '',
      has_multiple_users: '',
      tab: currentTab,
    });
  }, [currentSearch, currentPageSize, currentSortBy, currentSortOrder, currentTab, updateUrl]);

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

  const handleTabChange = useCallback(
    (tab: TableVariant) => {
      updateUrl({ ...sharedParams(), tab, page: '1' });
    },
    [sharedParams, updateUrl]
  );

  const buttons = create ? (
    <Button variant="outline" onClick={() => setIsCreateDialogOpen(true)}>
      <Plus className="h-4 w-4" />
      {create.label}
    </Button>
  ) : null;

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
    </BreadcrumbItem>
  );

  const tableContent = (variant: TableVariant) => (
    <>
      <div className="rounded-lg border">
        <Table>
          <OrganizationTableHeader
            variant={variant}
            sortConfig={sortConfig}
            onSort={handleSort}
            showDeleted={currentIncludeDeleted}
            showStripeStatus={showStripeStatus}
            showTrialEndDate={showTrialEndDate}
          />
          <OrganizationTableBody
            variant={variant}
            organizations={data?.organizations || []}
            isLoading={isLoading}
            searchTerm={currentSearch}
            showDeleted={currentIncludeDeleted}
            showStripeStatus={showStripeStatus}
            showTrialEndDate={showTrialEndDate}
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
            hasUsage={currentHasUsage}
            hasMultipleUsers={currentHasMultipleUsers}
            showStripeStatus={showStripeStatus}
            showTrialFilters={showTrialFilters}
            onIncludeDeletedChange={handleIncludeDeletedChange}
            onStripeStatusChange={handleStripeStatusChange}
            onPlanChange={handlePlanChange}
            onHasUsageChange={handleHasUsageChange}
            onHasMultipleUsersChange={handleHasMultipleUsersChange}
            onResetFilters={handleResetFilters}
            totalCount={data?.pagination.total}
            filteredCount={data?.pagination.total}
          />
        </div>

        <Tabs value={currentTab} onValueChange={v => handleTabChange(v as TableVariant)}>
          <TabsList>
            <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
          </TabsList>
          <TabsContent value="entitlements">{tableContent('entitlements')}</TabsContent>
          <TabsContent value="usage">{tableContent('usage')}</TabsContent>
        </Tabs>

        <CreateOrganizationDialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen} />
      </div>
    </AdminPage>
  );
}
