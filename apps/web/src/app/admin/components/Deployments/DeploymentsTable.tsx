'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ExternalLink, ChevronLeft, ChevronRight, X } from 'lucide-react';
import Link from 'next/link';
import { DeploymentDetailDialog } from './DeploymentDetailDialog';
import { StatusBadge } from '@/components/deployments/StatusBadge';
import type { AdminDeploymentTableProps } from '@/types/admin-deployments';

type SortField = 'created_at' | 'deployment_slug' | 'repository_source';
type SortOrder = 'asc' | 'desc';
type OwnerType = 'user' | 'org' | 'all';

function toSortedSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value) params.set(key, String(value));
  }
  return params;
}

export function DeploymentsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryStringState = useMemo(
    () => ({
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      sortBy: (searchParams.get('sortBy') || 'created_at') as SortField,
      sortOrder: (searchParams.get('sortOrder') || 'desc') as SortOrder,
      search: searchParams.get('search') || '',
      ownerType: (searchParams.get('ownerType') || 'all') as OwnerType,
    }),
    [searchParams]
  );

  const [searchInput, setSearchInput] = useState(queryStringState.search);
  const [selectedDeployment, setSelectedDeployment] = useState<AdminDeploymentTableProps | null>(
    null
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  const trpc = useTRPC();
  const { data, isLoading, error, isFetching } = useQuery(
    trpc.admin.deployments.list.queryOptions({
      page: queryStringState.page,
      limit: queryStringState.limit,
      sortBy: queryStringState.sortBy,
      sortOrder: queryStringState.sortOrder,
      search: queryStringState.search,
      ownerType: queryStringState.ownerType,
    })
  );

  type QueryStringState = typeof queryStringState;

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/deployments?${queryString.toString()}`);
    },
    [router, queryStringState]
  );

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      pushWith({ search: searchInput, page: 1 });
    },
    [pushWith, searchInput]
  );

  const handleClearSearch = useCallback(() => {
    setSearchInput('');
    pushWith({ search: '', page: 1 });
  }, [pushWith]);

  const handleOwnerTypeChange = useCallback(
    (ownerType: OwnerType) => {
      pushWith({ ownerType, page: 1 });
    },
    [pushWith]
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newDirection =
        queryStringState.sortBy === field && queryStringState.sortOrder === 'asc' ? 'desc' : 'asc';
      pushWith({ sortBy: field, sortOrder: newDirection, page: 1 });
    },
    [queryStringState.sortBy, queryStringState.sortOrder, pushWith]
  );

  const handlePageChange = useCallback(
    (page: number) => {
      pushWith({ page });
    },
    [pushWith]
  );

  const handleRowClick = useCallback((deployment: AdminDeploymentTableProps) => {
    setSelectedDeployment(deployment);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setSelectedDeployment(null);
    }
  }, []);

  const handleDelete = useCallback(() => {
    setSelectedDeployment(null);
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load deployments</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const deployments = data?.deployments || [];
  const pagination = data?.pagination || {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  };

  return (
    <div className="flex w-full flex-col gap-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-1 gap-2">
          <div className="relative max-w-md flex-1">
            <Input
              placeholder="Search by slug, repository, URL, user ID, or org ID..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pr-8"
            />
            {(searchInput || queryStringState.search) && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Button type="submit" disabled={isFetching}>
            Search
          </Button>
        </form>

        <Select value={queryStringState.ownerType} onValueChange={handleOwnerTypeChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Owner type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Owners</SelectItem>
            <SelectItem value="user">Users Only</SelectItem>
            <SelectItem value="org">Organizations Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('deployment_slug')}
              >
                Deployment Slug
                {queryStringState.sortBy === 'deployment_slug' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('repository_source')}
              >
                Repository
                {queryStringState.sortBy === 'repository_source' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('created_at')}
              >
                Created
                {queryStringState.sortBy === 'created_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>URL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  Loading deployments...
                </TableCell>
              </TableRow>
            ) : deployments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No deployments found.
                </TableCell>
              </TableRow>
            ) : (
              deployments.map(deployment => (
                <TableRow
                  key={deployment.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  onClick={() => handleRowClick(deployment)}
                >
                  <TableCell className="font-mono text-sm">{deployment.deployment_slug}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {deployment.repository_source}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{deployment.branch}</TableCell>
                  <TableCell>
                    {deployment.owned_by_user_id ? (
                      <Link
                        href={`/admin/users/${encodeURIComponent(deployment.owned_by_user_id)}`}
                        className="text-blue-600 hover:underline"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        {deployment.owner_email}
                      </Link>
                    ) : deployment.owned_by_organization_id ? (
                      <Link
                        href={`/admin/organizations/${deployment.owned_by_organization_id}`}
                        className="text-blue-600 hover:underline"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        {deployment.owner_org_name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Unknown</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {deployment.latest_build_status ? (
                      <StatusBadge status={deployment.latest_build_status} />
                    ) : (
                      <span className="text-muted-foreground text-sm">No builds</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(deployment.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <a
                      href={deployment.deployment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      onClick={e => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span className="text-sm">View</span>
                    </a>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-muted-foreground text-sm">
          Showing {deployments.length > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0} to{' '}
          {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}{' '}
          deployments
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(pagination.page - 1)}
            disabled={pagination.page <= 1 || isFetching}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <div className="text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages || isFetching}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Detail Dialog */}
      <DeploymentDetailDialog
        deployment={selectedDeployment}
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        onDelete={handleDelete}
      />
    </div>
  );
}
