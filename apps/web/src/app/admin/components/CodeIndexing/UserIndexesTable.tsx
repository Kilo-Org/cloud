'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatStorageSize } from '@/lib/code-indexing/format-storage-size';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SortableButton } from '@/app/admin/components/SortableButton';
import { useTRPC } from '@/lib/trpc/utils';
import Link from 'next/link';
import { formatRelativeTime } from '@/lib/admin-utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type UserSortField =
  | 'user_email'
  | 'chunk_count'
  | 'project_count'
  | 'branch_count'
  | 'percentage_of_rows'
  | 'size_kb'
  | 'last_modified';

export function UserIndexesTable() {
  const trpc = useTRPC();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<UserSortField>('size_kb');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { data, isLoading } = useQuery(
    trpc.codeIndexing.admin.getUserSummaryStats.queryOptions({
      page,
      pageSize,
      sortBy,
      sortOrder,
    })
  );

  const stats = data?.items || [];

  const handleSort = (field: UserSortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const renderSkeletonRows = (count: number) =>
    Array.from({ length: count }).map((_, idx) => (
      <TableRow key={idx}>
        <TableCell>
          <Skeleton className="h-4 w-48" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-10" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-10" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-16" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-12" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-20" />
        </TableCell>
        <TableCell className="text-right">
          <Skeleton className="ml-auto h-4 w-20" />
        </TableCell>
      </TableRow>
    ));

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <h3 className="text-xl font-semibold">User Indexes</h3>
        <p className="text-muted-foreground text-sm">Code indexes owned by individual users</p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SortableButton
                  field="user_email"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  User Email
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="project_count"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  Projects
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="branch_count"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  Branches
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="chunk_count"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  Chunk Count
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="percentage_of_rows"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  % of Total
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="size_kb"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  Estimated Size
                </SortableButton>
              </TableHead>
              <TableHead className="text-right">
                <SortableButton
                  field="last_modified"
                  onSort={handleSort}
                  sortConfig={{ field: sortBy, direction: sortOrder }}
                >
                  Last Modified
                </SortableButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              renderSkeletonRows(5)
            ) : stats.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                  No user code indexing data available
                </TableCell>
              </TableRow>
            ) : (
              stats.map(stat => (
                <TableRow key={stat.kilo_user_id}>
                  <TableCell>
                    <Link
                      href={`/admin/code-indexing/user?id=${encodeURIComponent(stat.kilo_user_id)}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                      prefetch={false}
                    >
                      {stat.user_email || 'Unknown User'}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {stat.project_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">{stat.branch_count.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{stat.chunk_count.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{stat.percentage_of_rows}%</TableCell>
                  <TableCell className="text-right">{formatStorageSize(stat.size_kb)}</TableCell>
                  <TableCell className="text-right" title={stat.last_modified}>
                    {formatRelativeTime(stat.last_modified)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, data.total)} of{' '}
            {data.total} users
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Rows per page:</span>
              <Select
                value={pageSize.toString()}
                onValueChange={value => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                disabled={page === data.totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
