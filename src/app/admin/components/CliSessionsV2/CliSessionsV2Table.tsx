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
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

type SortField = 'created_at' | 'updated_at' | 'title';
type SortOrder = 'asc' | 'desc';
type Platform = 'all' | 'unknown' | 'vscode' | 'cursor' | 'windsurf' | 'vim' | 'other';

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

export function CliSessionsV2Table() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryStringState = useMemo(
    () => ({
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      sortBy: (searchParams.get('sortBy') || 'created_at') as SortField,
      sortOrder: (searchParams.get('sortOrder') || 'desc') as SortOrder,
      search: searchParams.get('search') || '',
      platform: (searchParams.get('platform') || 'all') as Platform,
    }),
    [searchParams]
  );

  const [searchInput, setSearchInput] = useState(queryStringState.search);

  const trpc = useTRPC();
  const offset = (queryStringState.page - 1) * queryStringState.limit;

  const { data, isLoading, error, isFetching } = useQuery(
    trpc.admin.cliSessionsV2.list.queryOptions({
      offset,
      limit: queryStringState.limit,
      sortBy: queryStringState.sortBy,
      sortOrder: queryStringState.sortOrder,
      search: queryStringState.search,
      platform: queryStringState.platform,
    })
  );

  type QueryStringState = typeof queryStringState;

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/cli-sessions-v2?${queryString.toString()}`);
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

  const handlePlatformChange = useCallback(
    (platform: Platform) => {
      pushWith({ platform, page: 1 });
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

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load CLI sessions</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const sessions = data?.sessions || [];
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
              placeholder="Search by session ID, user ID, or title..."
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

        <Select value={queryStringState.platform} onValueChange={handlePlatformChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Platforms</SelectItem>
            <SelectItem value="vscode">VS Code</SelectItem>
            <SelectItem value="cursor">Cursor</SelectItem>
            <SelectItem value="windsurf">Windsurf</SelectItem>
            <SelectItem value="vim">Vim</SelectItem>
            <SelectItem value="unknown">Unknown</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session ID</TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('title')}
              >
                Title
                {queryStringState.sortBy === 'title' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>User</TableHead>
              <TableHead>Platform</TableHead>
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
                onClick={() => handleSort('updated_at')}
              >
                Updated
                {queryStringState.sortBy === 'updated_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead>Git</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  Loading sessions...
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No sessions found.
                </TableCell>
              </TableRow>
            ) : (
              sessions.map(session => (
                <TableRow
                  key={`${session.session_id}-${session.kilo_user_id}`}
                  className="hover:bg-muted/50 cursor-pointer"
                  tabIndex={0}
                  role="link"
                  onClick={() =>
                    router.push(
                      `/admin/cli-sessions-v2/${encodeURIComponent(session.session_id)}?userId=${encodeURIComponent(session.kilo_user_id)}`
                    )
                  }
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      router.push(
                        `/admin/cli-sessions-v2/${encodeURIComponent(session.session_id)}?userId=${encodeURIComponent(session.kilo_user_id)}`
                      );
                    }
                  }}
                >
                  <TableCell className="font-mono text-xs">
                    <span
                      className="block truncate"
                      style={{ maxWidth: '180px' }}
                      title={session.session_id}
                    >
                      {session.session_id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className="block truncate"
                      style={{ maxWidth: '250px' }}
                      title={session.title ?? undefined}
                    >
                      {session.title || <span className="text-muted-foreground">Untitled</span>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(session.kilo_user_id)}`}
                      className="text-blue-600 hover:underline"
                      onClick={e => e.stopPropagation()}
                    >
                      {session.owner_email || session.kilo_user_id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{session.created_on_platform}</Badge>
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={new Date(session.created_at).toLocaleString()}
                  >
                    {formatRelativeTime(session.created_at)}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={new Date(session.updated_at).toLocaleString()}
                  >
                    {formatRelativeTime(session.updated_at)}
                  </TableCell>
                  <TableCell>
                    {session.git_url ? (
                      <Badge variant="default" className="bg-green-600">
                        Yes
                      </Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
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
          Showing {sessions.length > 0 ? pagination.offset + 1 : 0} to{' '}
          {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}{' '}
          sessions
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
    </div>
  );
}
