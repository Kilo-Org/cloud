'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { UserTablePagination } from '../components/UserTablePagination';
import { UserSearchInput } from '../components/UserSearchInput';
import { UserAvatarLink } from '../components/UserAvatarLink';
import type { SortConfig, SortableField } from '@/types/admin';
import type { PageSize } from '@/types/pagination';
import { formatMicrodollars } from '@/lib/admin-utils';
import { formatIsoDateTime_IsoOrderNoSeconds } from '@/lib/utils';
import type { CreditCategoryUsersApiResponse } from '@/lib/PromoCreditCategoryConfig';

interface CreditCategoryUsersProps {
  creditCategoryKey: string;
}

// Sortable button component
function SortableButton({
  field,
  children,
  sortConfig,
  onSort,
}: {
  field: SortableField;
  children: React.ReactNode;
  sortConfig: SortConfig;
  onSort: (field: SortableField) => void;
}) {
  const getSortIcon = (field: SortableField) => {
    if (!sortConfig || sortConfig.field !== field) {
      return <ArrowUpDown className="ml-2 h-4 w-4" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onSort(field)}
      className={`h-8 pr-2 pl-0 lg:pr-3 ${sortConfig?.field === field ? 'text-primary font-bold' : ''}`}
    >
      {children}
      {getSortIcon(field)}
    </Button>
  );
}

export function CreditCategoryUsersTable({ creditCategoryKey }: CreditCategoryUsersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<CreditCategoryUsersApiResponse>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse URL parameters
  const currentPage = parseInt(searchParams.get('page') || '1');
  const currentPageSize = parseInt(searchParams.get('limit') || '25') as PageSize;
  const currentSearch = searchParams.get('search') || '';
  const currentSortBy = (searchParams.get('sortBy') || 'created_at') as SortableField;
  const currentSortOrder = searchParams.get('sortOrder') || 'desc';

  const sortConfig: SortConfig = useMemo(
    () => ({
      field: currentSortBy,
      direction: currentSortOrder as 'asc' | 'desc',
    }),
    [currentSortBy, currentSortOrder]
  );

  // Update URL with new parameters
  const updateUrl = useCallback(
    (params: Record<string, string>) => {
      const newSearchParams = new URLSearchParams(searchParams.toString());

      // Reset to page 1 when search or sort changes
      if (params.search !== undefined || params.sortBy !== undefined) {
        params.page = '1';
      }

      Object.entries(params).forEach(([key, value]) => {
        if (value) {
          newSearchParams.set(key, value);
        } else {
          newSearchParams.delete(key);
        }
      });

      router.push(`/admin/credit-categories/${creditCategoryKey}?${newSearchParams.toString()}`);
    },
    [router, searchParams, creditCategoryKey]
  );

  // Fetch data from API
  const fetchData = useCallback(
    async (params: Record<string, string>, isInitialLoad = false) => {
      if (isInitialLoad) {
        setIsLoading(true);
      } else {
        setIsSearching(true);
      }
      setError(null);

      try {
        const queryParams = new URLSearchParams(params);
        const response = await fetch(
          `/admin/api/credit-categories/${creditCategoryKey}?${queryParams.toString()}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('Credit category not found: ' + creditCategoryKey);
          }
          throw new Error('Failed to fetch credit category details: ' + creditCategoryKey);
        }

        const newData: CreditCategoryUsersApiResponse = await response.json();
        setData(newData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching credit category details:', err);
      } finally {
        if (isInitialLoad) {
          setIsLoading(false);
        } else {
          setIsSearching(false);
        }
      }
    },
    [creditCategoryKey]
  );

  // Handle search
  const handleSearchChange = useCallback(
    async (searchTerm: string) => {
      const params = {
        search: searchTerm,
        page: '1', // Reset to first page when searching
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
      };

      updateUrl(params);
      await fetchData(params, false); // Not initial load, so use search loading
    },
    [currentPageSize, currentSortBy, currentSortOrder, updateUrl, fetchData]
  );

  // Handle sorting
  const handleSort = useCallback(
    async (field: SortableField) => {
      const newDirection =
        sortConfig.field === field && sortConfig.direction === 'asc' ? 'desc' : 'asc';

      const params = {
        search: currentSearch,
        page: '1', // Reset to first page when sorting
        limit: currentPageSize.toString(),
        sortBy: field,
        sortOrder: newDirection,
      };

      updateUrl(params);
      await fetchData(params, false); // Not initial load, so use search loading
    },
    [sortConfig, currentPageSize, currentSearch, updateUrl, fetchData]
  );

  // Handle row click to navigate to user detail
  const handleRowClick = useCallback(
    (userId: string) => {
      router.push(`/admin/users/${encodeURIComponent(userId)}`);
    },
    [router]
  );

  // Handle page change
  const handlePageChange = useCallback(
    async (page: number) => {
      const params = {
        search: currentSearch,
        page: page.toString(),
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
      };

      updateUrl(params);
      await fetchData(params, false);
    },
    [currentPageSize, currentSearch, currentSortBy, currentSortOrder, updateUrl, fetchData]
  );

  // Handle page size change
  const handlePageSizeChange = useCallback(
    async (pageSize: PageSize) => {
      const params = {
        search: currentSearch,
        page: '1',
        limit: pageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
      };

      updateUrl(params);
      await fetchData(params, false);
    },
    [currentSearch, currentSortBy, currentSortOrder, updateUrl, fetchData]
  );

  // Load initial data
  useEffect(() => {
    if (data === undefined && !error) {
      const params = {
        search: currentSearch,
        page: currentPage.toString(),
        limit: currentPageSize.toString(),
        sortBy: currentSortBy,
        sortOrder: currentSortOrder,
      };
      void fetchData(params, true);
    }
  }, [
    data,
    error,
    currentPage,
    currentPageSize,
    currentSearch,
    currentSortBy,
    currentSortOrder,
    fetchData,
  ]);

  if (error) {
    return (
      <div className="py-8 text-center">
        <p className="text-muted-foreground text-sm">
          Failed to load credit category details: {error}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="bg-muted h-8 w-1/3 animate-pulse rounded" />
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
        <div className="bg-muted h-32 animate-pulse rounded" />
      </div>
    );
  }

  const { users } = data;

  return (
    <div className="space-y-4">
      {/* Search Section */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Participating Users</h2>
        <div className="w-80">
          <UserSearchInput
            value={currentSearch}
            onChange={handleSearchChange}
            isLoading={isSearching}
            placeholder="Search by email..."
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="w-[300px]">
                <SortableButton
                  field="google_user_email"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                >
                  User
                </SortableButton>
              </TableHead>
              <TableHead className="w-[120px]">Credit Amount</TableHead>
              <TableHead className="w-[150px]">Credit Date (UTC)</TableHead>
              <TableHead className="w-[150px]">
                <SortableButton field="created_at" sortConfig={sortConfig} onSort={handleSort}>
                  User Joined At (UTC)
                </SortableButton>
              </TableHead>
              <TableHead className="w-[120px]">
                <SortableButton
                  field="microdollars_used"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                >
                  User&apos;s Usage
                </SortableButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <div className="flex items-center space-x-3">
                      <div className="bg-muted h-8 w-8 animate-pulse rounded-full" />
                      <div className="bg-muted h-4 w-[200px] animate-pulse rounded" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="bg-muted h-4 w-[100px] animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-muted h-4 w-[80px] animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-muted h-4 w-[80px] animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-muted h-4 w-[100px] animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-muted-foreground">
                      {currentSearch
                        ? `No users found matching "${currentSearch}".`
                        : 'No users found for this credit category.'}
                    </p>
                    {currentSearch && (
                      <p className="text-muted-foreground text-sm">
                        Try adjusting your search terms or clear the search to see all users.
                      </p>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              users.map(row => (
                <TableRow
                  key={row.credit_transaction_id}
                  className="hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => handleRowClick(row.kilo_user_id)}
                >
                  <TableCell className="p-0 font-medium">
                    <div className="flex items-center px-4 py-1">
                      <UserAvatarLink
                        user={{
                          id: row.kilo_user_id,
                          google_user_name: row.google_user_name,
                          google_user_image_url: row.google_user_image_url,
                          google_user_email: row.google_user_email,
                        }}
                        className="flex items-center space-x-3"
                        avatarClassName="h-6 w-6 rounded-full"
                        nameClassName="hidden"
                      />
                      <span className="ml-3">{row.google_user_email}</span>
                      {row.is_admin && (
                        <Badge variant="secondary" className="ml-3 text-xs">
                          Admin
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{formatMicrodollars(row.transaction_amount)}</TableCell>
                  <TableCell>{formatIsoDateTime_IsoOrderNoSeconds(row.transaction_date)}</TableCell>
                  <TableCell>{formatIsoDateTime_IsoOrderNoSeconds(row.created_at)}</TableCell>
                  <TableCell>{formatMicrodollars(row.microdollars_used)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <UserTablePagination
        pagination={data.pagination}
        pageSize={currentPageSize}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        isLoading={isLoading}
      />
    </div>
  );
}
