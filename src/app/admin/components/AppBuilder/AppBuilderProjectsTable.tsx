'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, X, Trash2, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import type { AdminAppBuilderProject } from '@/routers/admin-app-builder-router';

type SortField = 'created_at' | 'last_message_at' | 'title';
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

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'Never';
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

export function AppBuilderProjectsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<AdminAppBuilderProject | null>(null);

  const trpc = useTRPC();
  const offset = (queryStringState.page - 1) * queryStringState.limit;

  const { data, isLoading, error, isFetching } = useQuery(
    trpc.admin.appBuilder.list.queryOptions({
      offset,
      limit: queryStringState.limit,
      sortBy: queryStringState.sortBy,
      sortOrder: queryStringState.sortOrder,
      search: queryStringState.search,
      ownerType: queryStringState.ownerType,
    })
  );

  const { mutateAsync: deleteProject, isPending: isDeleting } = useMutation(
    trpc.admin.appBuilder.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Project deleted successfully');
        void queryClient.invalidateQueries({ queryKey: trpc.admin.appBuilder.list.queryKey() });
        setDeleteDialogOpen(false);
        setProjectToDelete(null);
      },
      onError: error => {
        toast.error(`Failed to delete project: ${error.message}`);
      },
    })
  );

  type QueryStringState = typeof queryStringState;

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/app-builder?${queryString.toString()}`);
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

  const handleDeleteClick = useCallback((project: AdminAppBuilderProject) => {
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (projectToDelete) {
      await deleteProject({ id: projectToDelete.id });
    }
  }, [deleteProject, projectToDelete]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load App Builder projects</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const projects = data?.projects || [];
  const pagination = data?.pagination || {
    offset: 0,
    limit: 20,
    total: 0,
    totalPages: 1,
  };

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;

  return (
    <div className="flex w-full flex-col gap-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-1 gap-2">
          <div className="relative max-w-md flex-1">
            <Input
              placeholder="Search by title, user ID, or org ID..."
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
                onClick={() => handleSort('title')}
              >
                Title
                {queryStringState.sortBy === 'title' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('created_at')}
              >
                Created
                {queryStringState.sortBy === 'created_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('last_message_at')}
              >
                Last Activity
                {queryStringState.sortBy === 'last_message_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>Deployed</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  Loading projects...
                </TableCell>
              </TableRow>
            ) : projects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No projects found.
                </TableCell>
              </TableRow>
            ) : (
              projects.map(project => (
                <TableRow
                  key={project.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  tabIndex={0}
                  role="link"
                  onClick={() => router.push(`/admin/app-builder/${project.id}`)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      router.push(`/admin/app-builder/${project.id}`);
                    }
                  }}
                >
                  <TableCell className="font-medium">
                    <span
                      className="block truncate"
                      style={{ maxWidth: '300px' }}
                      title={project.title}
                    >
                      {project.title}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{project.model_id}</TableCell>
                  <TableCell>
                    {project.owned_by_user_id ? (
                      <Link
                        href={`/admin/users/${project.owned_by_user_id}`}
                        className="text-blue-600 hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        {project.owner_email || project.owned_by_user_id}
                      </Link>
                    ) : project.owned_by_organization_id ? (
                      <Link
                        href={`/admin/organizations/${project.owned_by_organization_id}`}
                        className="text-blue-600 hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        {project.owner_org_name || project.owned_by_organization_id}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Unknown</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">{project.message_count}</TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={new Date(project.created_at).toLocaleString()}
                  >
                    {formatRelativeTime(project.created_at)}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={
                      project.last_message_at
                        ? new Date(project.last_message_at).toLocaleString()
                        : undefined
                    }
                  >
                    {formatRelativeTime(project.last_message_at)}
                  </TableCell>
                  <TableCell>
                    {project.is_deployed ? (
                      <Badge variant="default" className="bg-green-600">
                        Yes
                      </Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={e => {
                        e.stopPropagation();
                        handleDeleteClick(project);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
          Showing {projects.length > 0 ? pagination.offset + 1 : 0} to{' '}
          {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}{' '}
          projects
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage <= 1 || isFetching}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <div className="text-sm">
            Page {currentPage} of {pagination.totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= pagination.totalPages || isFetching}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Delete Project
            </DialogTitle>
            <DialogDescription className="pt-3">
              Are you sure you want to delete this project?
              {projectToDelete && (
                <span className="text-foreground mt-2 block font-medium">
                  &quot;{projectToDelete.title}&quot;
                </span>
              )}
              <span className="mt-2 block">This action cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="secondary" disabled={isDeleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
