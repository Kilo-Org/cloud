'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { useCursorPagination } from '@/components/subscriptions/useCursorPagination';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { OrgKiloPassBillingHistoryCard } from './OrgKiloPassBillingHistoryCard';
import { useOpenBillingPortal } from './useOpenBillingPortal';

/**
 * Kilo Pass invoices for the parent organization. Seat and pass charges can
 * share an invoice, but seat-only invoices are omitted from this product view.
 */
export function OrgKiloPassBillingHistory({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const { openBillingPortal, isOpeningPortal } = useOpenBillingPortal(organizationId);

  const billingQuery = useQuery(
    trpc.organizations.kiloPass.billingHistory.queryOptions(
      { organizationId },
      { enabled: Boolean(organizationId) }
    )
  );
  const fetchMoreBilling = useCallback(
    (cursor: string) =>
      trpcClient.organizations.kiloPass.billingHistory.query({
        organizationId,
        cursor,
      }),
    [trpcClient, organizationId]
  );
  const billing = useCursorPagination({
    initialData: billingQuery.data,
    fetchMore: fetchMoreBilling,
    resetKey: organizationId,
  });

  return (
    <OrgKiloPassBillingHistoryCard
      action={
        <Button variant="outline" onClick={openBillingPortal} disabled={isOpeningPortal}>
          {isOpeningPortal ? 'Opening…' : 'Manage payment method'}
        </Button>
      }
    >
      {billingQuery.isError ? (
        <Alert variant="destructive">
          <RefreshCw aria-hidden />
          <AlertTitle>Billing history could not be loaded</AlertTitle>
          <AlertDescription>
            <p>
              {billingQuery.error instanceof Error
                ? billingQuery.error.message
                : 'Something went wrong while loading invoices.'}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void billingQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : billingQuery.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="type-label text-muted-foreground">
            Invoice totals include both seat and Kilo Pass charges.
          </p>
          <BillingHistoryTable
            variant="stripe"
            entries={billing.entries}
            hasMore={billing.hasMore}
            onLoadMore={() => void billing.loadMore()}
            isLoading={billing.isLoadingMore}
          />
        </div>
      )}
    </OrgKiloPassBillingHistoryCard>
  );
}
