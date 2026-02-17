'use client';

import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { BooleanBadge } from '@/components/ui/boolean-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';
import { formatMicrodollars, formatRelativeTime } from '@/lib/admin-utils';
import type { AdminOrganizationSchema } from '@/types/admin';
import type { z } from 'zod';
import Link from 'next/link';

type AdminOrganization = z.infer<typeof AdminOrganizationSchema>;

type OrganizationTableBodyProps = {
  organizations: AdminOrganization[];
  isLoading: boolean;
  searchTerm?: string;
  showDeleted?: boolean;
};

export function OrganizationTableBody({
  organizations,
  isLoading,
  searchTerm,
  showDeleted,
}: OrganizationTableBodyProps) {
  const router = useRouter();

  const handleRowClick = (organizationId: string) => {
    router.push(`/admin/organizations/${encodeURIComponent(organizationId)}`);
  };

  if (isLoading) {
    return (
      <TableBody>
        {Array.from({ length: 10 }).map((_, index) => (
          <TableRow key={index}>
            <TableCell>
              <Skeleton className="h-4 w-[150px]" />
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
              <Skeleton className="h-4 w-[60px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[100px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[120px]" />
            </TableCell>
            {showDeleted && (
              <TableCell>
                <Skeleton className="h-4 w-[80px]" />
              </TableCell>
            )}
            <TableCell>
              <Skeleton className="h-8 w-[80px]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    );
  }

  if (organizations.length === 0) {
    const message = searchTerm
      ? `No organizations found matching "${searchTerm}".`
      : 'No organizations found.';

    return (
      <TableBody>
        <TableRow>
          <TableCell colSpan={showDeleted ? 10 : 9} className="h-24 text-center">
            <div className="flex flex-col items-center gap-2">
              <p className="text-muted-foreground">{message}</p>
              {searchTerm && (
                <p className="text-muted-foreground text-sm">
                  Try adjusting your search terms or clear the search to see all organizations.
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
      {organizations.map(organization => (
        <TableRow
          key={organization.id}
          className="hover:bg-muted/50 cursor-pointer transition-colors"
          onClick={() => handleRowClick(organization.id)}
        >
          <TableCell className="min-w-40 font-medium">
            <div className="flex min-w-0 items-center space-x-3">
              <span>{organization.name}</span>
            </div>
          </TableCell>
          <TableCell className="min-w-30">
            <div className="flex flex-col">
              <span className="text-sm">{formatRelativeTime(organization.created_at)}</span>
            </div>
          </TableCell>
          <TableCell className="min-w-30">
            <span className="font-mono text-sm">
              {formatMicrodollars(organization.microdollars_used)}
            </span>
          </TableCell>
          <TableCell className="min-w-30">
            <span className="font-mono text-sm">
              {formatMicrodollars(
                organization.total_microdollars_acquired - organization.microdollars_used
              )}
            </span>
          </TableCell>
          <TableCell>
            <Badge variant="secondary">{organization.member_count}</Badge>
          </TableCell>
          <TableCell>
            <BooleanBadge positive={organization.require_seats}>
              {organization.require_seats ? 'Yes' : 'No'}
            </BooleanBadge>
          </TableCell>
          <TableCell>
            {organization.plan ? (
              <Badge variant="secondary" className="capitalize">
                {organization.plan}
              </Badge>
            ) : (
              <span className="text-muted-foreground text-sm">-</span>
            )}
          </TableCell>
          <TableCell className="min-w-30">
            {organization.subscription_amount_usd ? (
              <span className="font-mono text-sm">
                ${organization.subscription_amount_usd.toFixed(2)}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">-</span>
            )}
          </TableCell>
          <TableCell className="min-w-40">
            {organization.created_by_kilo_user_id && organization.created_by_user_email ? (
              <Link
                href={`/admin/users/${encodeURIComponent(organization.created_by_kilo_user_id)}`}
                target="_blank"
                className="cursor-pointer hover:text-blue-600"
                onClick={e => e.stopPropagation()}
              >
                {organization.created_by_user_email}
              </Link>
            ) : (
              <span className="text-muted-foreground text-sm">Not set</span>
            )}
          </TableCell>
          {showDeleted && (
            <TableCell>
              <BooleanBadge positive={!organization.deleted_at}>
                {organization.deleted_at ? 'Yes' : 'No'}
              </BooleanBadge>
            </TableCell>
          )}
          <TableCell>
            <a
              href={`/organizations/${organization.id}`}
              target="_blank"
              className="inline-flex items-center rounded-md bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-200"
              onClick={e => e.stopPropagation()}
            >
              View Org
            </a>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  );
}
