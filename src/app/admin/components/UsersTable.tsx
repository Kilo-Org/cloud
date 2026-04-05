'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Table } from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserTableHeader } from './UserTableHeader';
import { UserTableBody } from './UserTableBody';
import { UserTablePagination } from './UserTablePagination';
import { UserFilters } from './UserFilters';
import type { UsersApiResponse, SortConfig, SortableField } from '@/types/admin';
import { ascendingFirstFields } from '@/types/admin';
import type { PageSize } from '@/types/pagination';

function toSortedSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value) params.set(key, String(value));
  }
  return params;
}

export function UsersTable() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryStringState = useMemo(
    () => ({
      page: parseInt(searchParams.get('page') || '1').toString(),
      limit: parseInt(searchParams.get('limit') || '25') as PageSize,
      sortBy: (searchParams.get('sortBy') || 'created_at') as SortableField,
      sortOrder: (searchParams.get('sortOrder') || 'desc') as 'asc' | 'desc',
      search: searchParams.get('search') || '',
      notesSearch: searchParams.get('notesSearch') || '',
      hasValidationStytch: searchParams.get('hasValidationStytch') || 'all',
      hasValidationNovelCard: searchParams.get('hasValidationNovelCard') || 'all',
      blockedStatus: searchParams.get('blockedStatus') || 'all',
      orgMembership: searchParams.get('orgMembership') || 'all',
      paymentStatus: searchParams.get('paymentStatus') || 'all',
      autoTopUp: searchParams.get('autoTopUp') || 'all',
    }),
    [searchParams]
  );

  const sortConfig: SortConfig = useMemo(
    () => ({
      field: queryStringState.sortBy,
      direction: queryStringState.sortOrder,
    }),
    [queryStringState.sortBy, queryStringState.sortOrder]
  );

  type QueryStringState = typeof queryStringState;

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['admin-users', queryStringState] as const,
    queryFn: async ({ queryKey: [, params], signal }) => {
      const response = await fetch(`/admin/api/users?${toSortedSearchParams(params).toString()}`, {
        signal,
      });

      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }

      return (await response.json()) as UsersApiResponse;
    },
  });

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/users?${queryString.toString()}`);
    },
    [router, queryStringState]
  );

  const handleSearchChange = useCallback(
    (search: string) => pushWith({ search: search, page: '' }),
    [pushWith]
  );

  const handleNotesSearchChange = useCallback(
    (notesSearch: string) => pushWith({ notesSearch: notesSearch, page: '' }),
    [pushWith]
  );

  const handleHasValidationStytchChange = useCallback(
    (hasValidationStytch: string) =>
      pushWith({ hasValidationStytch: hasValidationStytch, page: '' }),
    [pushWith]
  );

  const handleHasValidationNovelCardChange = useCallback(
    (hasValidationNovelCard: string) =>
      pushWith({ hasValidationNovelCard: hasValidationNovelCard, page: '' }),
    [pushWith]
  );

  const handleBlockedStatusChange = useCallback(
    (blockedStatus: string) => pushWith({ blockedStatus: blockedStatus, page: '' }),
    [pushWith]
  );

  const handleOrgMembershipChange = useCallback(
    (orgMembership: string) => pushWith({ orgMembership: orgMembership, page: '' }),
    [pushWith]
  );

  const handlePaymentStatusChange = useCallback(
    (paymentStatus: string) => pushWith({ paymentStatus: paymentStatus, page: '' }),
    [pushWith]
  );

  const handleAutoTopUpChange = useCallback(
    (autoTopUp: string) => pushWith({ autoTopUp: autoTopUp, page: '' }),
    [pushWith]
  );

  const handleSort = useCallback(
    (field: SortableField) => {
      const isAscFirst = ascendingFirstFields.includes(field);
      const defaultDirection = isAscFirst ? 'asc' : 'desc';
      const alternateDirection = isAscFirst ? 'desc' : 'asc';

      const newDirection =
        sortConfig.field === field && sortConfig.direction === defaultDirection
          ? alternateDirection
          : defaultDirection;

      pushWith({ sortBy: field, sortOrder: newDirection, page: '' });
    },
    [sortConfig, pushWith]
  );

  const handlePageChange = useCallback(
    (page: number) => pushWith({ page: page.toString() }),
    [pushWith]
  );

  const handlePageSizeChange = useCallback(
    (pageSize: PageSize) => pushWith({ limit: pageSize, page: '' }),
    [pushWith]
  );

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load users</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      className="inline-grid auto-rows-min gap-y-4"
      style={{ gridTemplateColumns: 'min-content' }}
    >
      <UserFilters
        search={queryStringState.search}
        onSearchChange={handleSearchChange}
        hasValidationStytch={queryStringState.hasValidationStytch}
        hasValidationNovelCard={queryStringState.hasValidationNovelCard}
        onHasValidationStytchChange={handleHasValidationStytchChange}
        onHasValidationNovelCardChange={handleHasValidationNovelCardChange}
        blockedStatus={queryStringState.blockedStatus}
        onBlockedStatusChange={handleBlockedStatusChange}
        orgMembership={queryStringState.orgMembership}
        onOrgMembershipChange={handleOrgMembershipChange}
        paymentStatus={queryStringState.paymentStatus}
        onPaymentStatusChange={handlePaymentStatusChange}
        autoTopUp={queryStringState.autoTopUp}
        onAutoTopUpChange={handleAutoTopUpChange}
        notesSearch={queryStringState.notesSearch}
        onNotesSearchChange={handleNotesSearchChange}
        isLoading={isFetching}
      />

      <div className="rounded-lg border">
        <Table>
          <UserTableHeader sortConfig={sortConfig} onSort={handleSort} />
          <UserTableBody
            users={data?.users || []}
            isLoading={isLoading}
            searchTerm={queryStringState.search}
          />
        </Table>
      </div>

      <UserTablePagination
        pagination={
          data?.pagination || {
            page: 1,
            total: 0,
            totalPages: 1,
            limit: queryStringState.limit,
          }
        }
        pageSize={queryStringState.limit}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        isLoading={isLoading}
      />
    </div>
  );
}
