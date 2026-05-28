'use client';

import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';
import { formatMicrodollars } from '@/lib/admin-utils';
import type { AdminOrganizationSchema } from '@/types/admin';
import type { z } from 'zod';
import { ExternalLink } from 'lucide-react';

type AdminOrganization = z.infer<typeof AdminOrganizationSchema>;

const STRIPE_STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  past_due: 'bg-yellow-100 text-yellow-800',
  canceled: 'bg-red-100 text-red-800',
  ended: 'bg-gray-100 text-gray-700',
  incomplete: 'bg-orange-100 text-orange-800',
  incomplete_expired: 'bg-red-100 text-red-700',
  trialing: 'bg-blue-100 text-blue-800',
  unpaid: 'bg-red-100 text-red-800',
  paused: 'bg-purple-100 text-purple-800',
};

function StripeStatusBadge({ status }: { status: string }) {
  const style = STRIPE_STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700';
  const label = status.replace(/_/g, ' ');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${style}`}
    >
      {label}
    </span>
  );
}

type OrganizationTableBodyProps = {
  organizations: AdminOrganization[];
  isLoading: boolean;
  searchTerm?: string;
  showDeleted?: boolean;
};

const COLUMN_COUNT_BASE = 11;

export function OrganizationTableBody({
  organizations,
  isLoading,
  searchTerm,
  showDeleted,
}: OrganizationTableBodyProps) {
  const router = useRouter();
  const colSpan = showDeleted ? COLUMN_COUNT_BASE + 1 : COLUMN_COUNT_BASE;

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
              <Skeleton className="h-4 w-[80px]" />
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
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[60px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[60px]" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-[80px]" />
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
          <TableCell colSpan={colSpan} className="h-24 text-center">
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
            <span>{organization.name}</span>
          </TableCell>
          <TableCell className="min-w-28">
            <span className="font-mono text-sm">
              {formatMicrodollars(organization.microdollars_used)}
            </span>
          </TableCell>
          <TableCell className="min-w-28">
            <span className="font-mono text-sm">
              {formatMicrodollars(
                organization.total_microdollars_acquired - organization.microdollars_used
              )}
            </span>
          </TableCell>
          <TableCell className="min-w-28">
            <span className="text-sm tabular-nums">
              <span className="font-medium">{organization.member_count}</span>
              {organization.seat_count > 0 && (
                <span className="text-muted-foreground"> / {organization.seat_count}</span>
              )}
            </span>
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
          <TableCell>
            {organization.latest_stripe_status ? (
              <StripeStatusBadge status={organization.latest_stripe_status} />
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </TableCell>
          <TableCell className="min-w-28">
            {organization.subscription_amount_usd ? (
              <span className="font-mono text-sm">
                ${organization.subscription_amount_usd.toFixed(2)}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">-</span>
            )}
          </TableCell>
          <TableCell>
            {organization.kilo_pass_tier ? (
              <span className="text-sm font-medium capitalize">
                {organization.kilo_pass_tier.replace(/_/g, ' ')}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </TableCell>
          <TableCell>
            <span className="text-sm tabular-nums font-medium">
              {organization.kiloclaw_count}
            </span>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
              {organization.stripe_customer_id && (
                <a
                  href={`https://dashboard.stripe.com/customers/${organization.stripe_customer_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-200"
                  title="View in Stripe"
                >
                  Stripe
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <a
                href={`https://app.usepylon.com/conversations?search=${encodeURIComponent(organization.name)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-200"
                title="View in Pylon"
              >
                Pylon
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </TableCell>
          {showDeleted && (
            <TableCell>
              <span className="text-muted-foreground text-sm">
                {organization.deleted_at ? 'Yes' : 'No'}
              </span>
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
