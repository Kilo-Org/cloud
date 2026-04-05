'use client';

import Link from 'next/link';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { UserTableProps } from '@/types/admin';
import { formatMicrodollars, formatRelativeTime } from '@/lib/admin-utils';
import { UserStatusBadge } from '@/components/admin/UserStatusBadge';
import { UserAvatarLink } from './UserAvatarLink';
import { Check } from 'lucide-react';

type UserTableBodyProps = {
  users: UserTableProps[];
  isLoading: boolean;
  searchTerm?: string;
};

export function UserTableBody({ users, isLoading, searchTerm }: UserTableBodyProps) {
  if (isLoading) {
    return (
      <TableBody>
        {Array.from({ length: 10 }).map((_, index) => (
          <TableRow key={index}>
            <TableCell>
              <Skeleton className="h-4 w-[250px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[100px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[100px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-6 w-[60px] rounded-full" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-6 w-[80px] rounded-full" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[20px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[20px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-6 w-[100px]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    );
  }

  if (users.length === 0) {
    const message = searchTerm ? `No users found matching "${searchTerm}".` : 'No users found.';

    return (
      <TableBody>
        <TableRow>
          <TableCell colSpan={11} className="h-24 text-center">
            <div className="flex flex-col items-center gap-2">
              <p className="text-muted-foreground">{message}</p>
              {searchTerm && (
                <p className="text-muted-foreground text-sm">
                  Try adjusting your search terms or clear the search to see all users.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    );
  }

  return (
    <TableBody>
      {users.map(user => {
        const userDetailUrl = `/admin/users/${encodeURIComponent(user.id)}`;
        return (
          <TableRow
            key={user.id}
            className={`hover:bg-muted/50 group relative transition-colors ${user.blocked_reason || user.is_blacklisted_by_domain ? 'bg-red-950 hover:bg-red-900' : ''}`}
          >
            <TableCell className="relative p-0 font-medium" style={{ maxWidth: '25em' }}>
              <UserAvatarLink
                user={user}
                className="flex h-full w-full items-center space-x-3 px-4 py-1"
                avatarClassName="h-6 w-6 shrink-0"
                nameClassName="truncate"
                displayFormat="email-name"
              />
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <span className="text-sm">{formatRelativeTime(user.created_at)}</span>
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <span className="text-sm">{formatRelativeTime(user.updated_at)}</span>
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <span className="font-mono text-sm">
                  {formatMicrodollars(user.total_microdollars_acquired)}
                </span>
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <span className="font-mono text-sm">
                  {formatMicrodollars(user.microdollars_used)}
                </span>
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <span className="font-mono text-sm">
                  {formatMicrodollars(user.total_microdollars_acquired - user.microdollars_used)}
                </span>
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                {user.admin_notes.length > 0 ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="secondary" className="relative z-10">
                          {user.admin_notes.length}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="flex flex-col gap-2 p-2">
                          {user.admin_notes.map(note => (
                            <div key={note.id} className="text-sm">
                              <p className="font-bold">{note.note_content}</p>
                              <p className="text-muted-foreground text-xs">
                                {formatRelativeTime(note.created_at)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  '-'
                )}
              </Link>
            </TableCell>
            <TableCell className="relative p-0">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                <UserStatusBadge is_detail={false} user={user} />
              </Link>
            </TableCell>
            <TableCell className="relative p-0 text-center">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                {user.total_microdollars_acquired > 0 && (
                  <Check className="mx-auto h-4 w-4 text-green-500" aria-label="Has paid" />
                )}
              </Link>
            </TableCell>
            <TableCell className="relative p-0 text-center">
              <Link href={userDetailUrl} className="block h-full w-full px-4 py-1">
                {user.auto_top_up_enabled && (
                  <Check
                    className="mx-auto h-4 w-4 text-green-500"
                    aria-label="Auto top-up enabled"
                  />
                )}
              </Link>
            </TableCell>
            <TableCell className="relative">
              <div className="relative z-10 flex gap-2">
                <a
                  href={`https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}customers/${user.stripe_customer_id}`}
                  target="_blank"
                  className="inline-flex items-center rounded-full bg-purple-100 px-2 py-1 text-xs font-medium text-purple-800 transition-colors hover:bg-purple-200"
                  onClick={e => e.stopPropagation()}
                >
                  Stripe
                </a>
              </div>
            </TableCell>
          </TableRow>
        );
      })}
    </TableBody>
  );
}
