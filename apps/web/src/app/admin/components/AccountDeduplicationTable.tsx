'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime, formatMicrodollars } from '@/lib/admin-utils';
import type { AccountDeduplicationResponse } from '../api/account-deduplication/route';

const PAGE_SIZE = 20;

export function AccountDeduplicationTable() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<AccountDeduplicationResponse>({
    queryKey: ['account-deduplication', page],
    queryFn: async () => {
      const res = await fetch(`/admin/api/account-deduplication?page=${page}&limit=${PAGE_SIZE}`);
      return res.json() as Promise<AccountDeduplicationResponse>;
    },
  });

  const pagination = data?.pagination;
  const groups = data?.groups ?? [];
  const hasNext = pagination ? page < pagination.totalPages : false;
  const hasPrev = page > 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Users sharing the same normalized email address. Each group may indicate duplicate
          accounts.
        </p>
        {pagination && (
          <Badge variant="secondary">
            {pagination.total.toLocaleString()} duplicate group{pagination.total !== 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Normalized Email</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Acquired</TableHead>
              <TableHead>Used</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  <p className="text-muted-foreground">No duplicate accounts found.</p>
                </TableCell>
              </TableRow>
            ) : (
              groups.map(group => (
                <DuplicateGroupRows
                  key={group.normalized_email}
                  normalizedEmail={group.normalized_email}
                  users={group.users}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev}
              onClick={() => setPage(p => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DuplicateGroupRows({
  normalizedEmail,
  users,
}: {
  normalizedEmail: string;
  users: AccountDeduplicationResponse['groups'][number]['users'];
}) {
  return (
    <>
      {users.map((user, i) => (
        <TableRow
          key={user.id}
          className={`${user.blocked_reason ? 'bg-red-950/30' : ''} ${i === users.length - 1 ? 'border-b-2 border-b-border' : ''}`}
        >
          {i === 0 ? (
            <TableCell rowSpan={users.length} className="align-top font-mono text-xs">
              {normalizedEmail}
              <Badge variant="secondary" className="ml-2">
                {users.length}
              </Badge>
            </TableCell>
          ) : null}
          <TableCell>
            <div className="flex items-center gap-2">
              <img
                src={user.google_user_image_url}
                alt=""
                className="h-6 w-6 rounded-full"
                onError={e => {
                  (e.target as HTMLImageElement).src = '/default-avatar.svg';
                }}
              />
              <a
                href={`/admin/users/${encodeURIComponent(user.id)}`}
                className="text-sm font-medium hover:underline"
              >
                {user.google_user_name}
              </a>
            </div>
          </TableCell>
          <TableCell>
            <a
              href={`/admin/users/${encodeURIComponent(user.id)}`}
              className="text-sm hover:underline"
            >
              {user.google_user_email}
            </a>
          </TableCell>
          <TableCell className="text-sm">{formatRelativeTime(user.created_at)}</TableCell>
          <TableCell className="font-mono text-sm">
            {formatMicrodollars(user.total_microdollars_acquired)}
          </TableCell>
          <TableCell className="font-mono text-sm">
            {formatMicrodollars(user.microdollars_used)}
          </TableCell>
          <TableCell>
            {user.blocked_reason ? (
              <Badge variant="destructive">Blocked</Badge>
            ) : (
              <Badge variant="default" className="bg-green-600">
                Active
              </Badge>
            )}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
