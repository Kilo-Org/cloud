'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';
import { useTRPC } from '@/lib/trpc/utils';
import { TRPCClientError } from '@trpc/client';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { AutoTopUpToggle } from '@/components/payment/AutoTopUpToggle';
import {
  TOPUP_STATUS_PENDING,
  TOPUP_STATUS_QUERY_STRING_KEY,
  TOPUP_TRANSACTION_QUERY_STRING_KEY,
} from '@/lib/organizations/constants';
import * as z from 'zod';
import { toast } from 'sonner';

const EXPIRY_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

const HEADER_ACTIONS = (
  <Link
    href="/subscriptions"
    className="type-body flex items-center gap-1 text-blue-400 hover:underline"
  >
    Manage subscriptions <ChevronRight className="size-4" />
  </Link>
);

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`type-eyebrow text-muted-foreground px-4 py-3 sm:px-6 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  numeric = false,
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`type-body px-4 py-3 whitespace-nowrap sm:px-6 ${align === 'right' ? 'text-right' : ''} ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

function formatExpiryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return EXPIRY_TIMESTAMP_FORMATTER.format(date);
}

function deductionKindLabel(kind: 'deduction' | 'adjustment' | 'balance_neutral'): string {
  switch (kind) {
    case 'balance_neutral':
      return 'Balance neutral';
    case 'adjustment':
      return 'Adjustment';
    case 'deduction':
      return 'Deduction';
  }
}

function CreditsPageContent() {
  const router = useRouter();
  const trpc = useTRPC();
  const searchParams = useSearchParams();
  const [historyCursor, setHistoryCursor] = useState(0);
  const [paymentPendingDismissed, setPaymentPendingDismissed] = useState(false);

  const transactionIdParam = searchParams.get(TOPUP_TRANSACTION_QUERY_STRING_KEY);
  const transactionIdIsValid = z.uuid().safeParse(transactionIdParam).success;
  const isPaymentPending = searchParams.get(TOPUP_STATUS_QUERY_STRING_KEY) === TOPUP_STATUS_PENDING;
  const shouldPollPendingPayment = isPaymentPending && !paymentPendingDismissed;
  const hasTopUpContext = transactionIdIsValid || isPaymentPending;

  const {
    data: creditData,
    isLoading,
    error,
    refetch,
  } = useQuery(
    trpc.user.getCreditBlocks.queryOptions(
      {},
      {
        refetchInterval: shouldPollPendingPayment ? 5000 : false,
        refetchOnMount: hasTopUpContext ? 'always' : true,
      }
    )
  );
  const {
    data: purchaseHistoryData,
    isLoading: isPurchaseHistoryLoading,
    isError: isPurchaseHistoryError,
    refetch: refetchPurchaseHistory,
  } = useQuery(
    trpc.user.getCreditPurchaseHistory.queryOptions(
      { cursor: historyCursor },
      {
        refetchInterval: shouldPollPendingPayment ? 5000 : false,
        refetchOnMount: hasTopUpContext ? 'always' : true,
      }
    )
  );
  const { data: confirmation, isError: isPurchaseConfirmationError } = useQuery(
    trpc.user.getCreditPurchaseConfirmation.queryOptions(
      { transactionId: transactionIdParam ?? '' },
      { enabled: transactionIdIsValid, retry: false }
    )
  );
  const receiptMutation = useMutation(trpc.user.getCreditPurchaseReceipt.mutationOptions());

  useEffect(() => {
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      router.push('/users/sign_in?callbackPath=/credits');
    }
  }, [error, router]);

  const dismissTopUpStatus = () => {
    setPaymentPendingDismissed(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete(TOPUP_TRANSACTION_QUERY_STRING_KEY);
    params.delete(TOPUP_STATUS_QUERY_STRING_KEY);
    const query = params.toString();
    router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, {
      scroll: false,
    });
  };

  const openReceipt = async (transactionId: string) => {
    try {
      const result = await receiptMutation.mutateAsync({ transactionId });
      if (!result.url) {
        toast.error('Invoice is unavailable for this purchase.');
        return;
      }
      window.location.assign(result.url);
    } catch (receiptError) {
      toast.error(
        receiptError instanceof Error ? receiptError.message : 'Could not open the invoice.'
      );
    }
  };

  if (isLoading) {
    return (
      <PageLayout
        title="Credits"
        subtitle="Buy credits, view your balance, and manage auto top-up."
        headerActions={HEADER_ACTIONS}
      >
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <Skeleton className="h-8 w-36" />
              <Skeleton className="mt-1 h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-16 w-full rounded-lg" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-24 w-full rounded-lg" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-16 w-full rounded-lg" />
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-1 h-4 w-64" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted border-b">
                      <Th>Purchase Date</Th>
                      <Th>Type</Th>
                      <Th>Credits Added</Th>
                      <Th>Invoice</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {['first', 'second', 'third'].map(row => (
                      <tr key={row} className="even:bg-muted group">
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-20" />
                        </Td>
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-24" />
                        </Td>
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-16" />
                        </Td>
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-16" />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      return (
        <PageLayout title="Credits">
          <div className="flex items-center justify-center py-12">
            <p className="type-body text-muted-foreground">Redirecting to sign in...</p>
          </div>
        </PageLayout>
      );
    }

    return (
      <PageLayout title="Credits">
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <p className="type-body text-destructive">
            {error instanceof TRPCClientError
              ? error.message
              : 'Something went wrong. Try refreshing the page.'}
          </p>
          <Button onClick={() => refetch()} variant="outline">
            Try again
          </Button>
        </div>
      </PageLayout>
    );
  }

  if (!creditData) {
    return (
      <PageLayout title="Credits">
        <div className="flex items-center justify-center py-12">
          <p className="type-body text-muted-foreground">No credit data available</p>
        </div>
      </PageLayout>
    );
  }

  const currentBalance = creditData.totalBalance_mUsd;
  const nextPromotionalExpiry = creditData.creditBlocks.reduce<string | null>(
    (earliestExpiry, block) => {
      if (!block.is_free || !block.expiry_date) return earliestExpiry;
      if (!earliestExpiry) return block.expiry_date;
      return new Date(block.expiry_date) < new Date(earliestExpiry)
        ? block.expiry_date
        : earliestExpiry;
    },
    null
  );
  const showUnverifiedConfirmation =
    transactionIdIsValid && isPurchaseConfirmationError && !confirmation;

  return (
    <PageLayout
      title="Credits"
      subtitle="Buy credits, view your balance, and manage auto top-up."
      headerActions={HEADER_ACTIONS}
    >
      <div className="flex flex-col gap-6">
        {confirmation && (
          <Card
            className="border-status-success-border bg-status-success-surface"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="text-status-success-icon mt-0.5 size-4 shrink-0" />
                  <div>
                    <p className="text-status-success type-heading">
                      {formatMicrodollars(confirmation.amount_mUsd)} in credits added
                    </p>
                    <p className="type-body text-muted-foreground mt-0.5 tabular-nums">
                      Current balance: {formatMicrodollars(currentBalance)}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss purchase confirmation"
                  className="size-control-touch sm:size-control-default text-muted-foreground hover:text-foreground shrink-0"
                  onClick={dismissTopUpStatus}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {isPaymentPending && (
          <Card
            className="border-status-warning-border bg-status-warning-surface"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Loader2 className="text-status-warning-icon mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                  <div>
                    <p className="text-status-warning type-heading">Payment is still processing</p>
                    <p className="type-body text-muted-foreground mt-0.5">
                      Your balance and purchase history will update when processing completes.
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss payment status"
                  className="size-control-touch sm:size-control-default text-muted-foreground hover:text-foreground shrink-0"
                  onClick={dismissTopUpStatus}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {showUnverifiedConfirmation && (
          <Card
            className="border-status-warning-border bg-status-warning-surface"
            role="status"
            aria-live="polite"
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Info className="text-status-warning-icon mt-0.5 size-4 shrink-0" />
                  <div>
                    <p className="text-status-warning type-heading">
                      Purchase confirmation is unavailable
                    </p>
                    <p className="type-body text-muted-foreground mt-0.5">
                      Check your balance and purchase history before trying the payment again.
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss purchase status"
                  className="size-control-touch sm:size-control-default text-muted-foreground hover:text-foreground shrink-0"
                  onClick={dismissTopUpStatus}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Your credit balance</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1px_1fr_1px_1fr]">
              <div>
                <div className="type-title text-foreground tabular-nums">
                  {formatMicrodollars(currentBalance)}
                </div>
                <div className="type-label text-muted-foreground mt-1">available</div>
              </div>

              <div className="bg-border hidden w-px self-stretch lg:block" />

              <div className="flex items-start gap-2">
                <CheckCircle2 className="text-status-success-icon mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="type-body text-muted-foreground">Purchased credits</p>
                  <p className="type-body font-medium">Never expire</p>
                </div>
              </div>

              <div className="bg-border hidden w-px self-stretch lg:block" />

              <div className="flex items-start gap-2">
                <CalendarDays className="text-status-info-icon mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="type-body text-muted-foreground">Next promotional expiry</p>
                  {nextPromotionalExpiry ? (
                    <p className="type-body font-medium">
                      {formatExpiryTimestamp(nextPromotionalExpiry)}
                    </p>
                  ) : (
                    <p className="type-body font-medium">None scheduled</p>
                  )}
                </div>
              </div>
            </div>

            <div className="type-label text-muted-foreground border-border border-t pt-4">
              Purchased credits do not expire. Promotional credits may have their own expiration
              timestamp.
            </div>
          </CardContent>
        </Card>

        <CreditPurchaseOptions isFirstPurchase={creditData.isFirstPurchase} />

        <Card>
          <CardHeader>
            <CardTitle>Automatic Top Up</CardTitle>
          </CardHeader>
          <CardContent>
            <AutoTopUpToggle />
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Credit purchase history</CardTitle>
            <CardDescription>Completed personal credit purchases and invoices.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr className="bg-muted border-b">
                    <Th>Purchase Date</Th>
                    <Th>Type</Th>
                    <Th>Credits Added</Th>
                    <Th>Invoice</Th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {isPurchaseHistoryLoading && (
                    <tr>
                      <Td>
                        <Skeleton className="h-4 w-20" />
                      </Td>
                      <Td>
                        <Skeleton className="h-4 w-24" />
                      </Td>
                      <Td>
                        <Skeleton className="h-4 w-16" />
                      </Td>
                      <Td>
                        <Skeleton className="h-4 w-20" />
                      </Td>
                    </tr>
                  )}
                  {purchaseHistoryData?.entries.map(entry => {
                    const isOpeningReceipt =
                      receiptMutation.isPending &&
                      receiptMutation.variables?.transactionId === entry.id;
                    return (
                      <tr key={entry.id} className="even:bg-muted">
                        <Td>{formatIsoDateString_UsaDateOnlyFormat(entry.date)}</Td>
                        <Td>{entry.description}</Td>
                        <Td numeric>{formatMicrodollars(entry.amount_mUsd)}</Td>
                        <Td>
                          <Button
                            variant="link"
                            className="h-auto p-0"
                            disabled={receiptMutation.isPending}
                            onClick={() => openReceipt(entry.id)}
                          >
                            {isOpeningReceipt ? (
                              <>
                                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                                Opening...
                              </>
                            ) : (
                              <>
                                View invoice <ExternalLink className="size-3" />
                              </>
                            )}
                          </Button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {isPurchaseHistoryError && (
              <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                <p className="type-body text-destructive">Could not load purchase history.</p>
                <Button variant="outline" onClick={() => refetchPurchaseHistory()}>
                  Try again
                </Button>
              </div>
            )}
            {purchaseHistoryData?.entries.length === 0 && (
              <div className="type-body text-muted-foreground px-6 py-12 text-center">
                No credit purchases yet.
              </div>
            )}
            {purchaseHistoryData &&
              (purchaseHistoryData.previousCursor !== null ||
                purchaseHistoryData.nextCursor !== null) && (
                <div className="border-border flex items-center justify-end gap-2 border-t px-6 py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={purchaseHistoryData.previousCursor === null}
                    onClick={() =>
                      setHistoryCursor(purchaseHistoryData?.previousCursor ?? historyCursor)
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={purchaseHistoryData.nextCursor === null}
                    onClick={() =>
                      setHistoryCursor(purchaseHistoryData?.nextCursor ?? historyCursor)
                    }
                  >
                    Next
                  </Button>
                </div>
              )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Credit deductions and adjustments</CardTitle>
            <CardDescription>
              Usage, expirations, and balance-neutral billing entries.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr className="bg-muted border-b">
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Type</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {creditData.deductions.map(deduction => (
                    <tr key={deduction.id} className="even:bg-muted">
                      <Td>{formatIsoDateString_UsaDateOnlyFormat(deduction.date)}</Td>
                      <Td className="whitespace-normal">{deduction.description}</Td>
                      <Td>{deductionKindLabel(deduction.kind)}</Td>
                      <Td numeric align="right">
                        -{formatMicrodollars(Math.abs(deduction.amount_mUsd))}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {creditData.deductions.length === 0 && (
              <div className="type-body text-muted-foreground px-6 py-12 text-center">
                No credit deductions or adjustments yet.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-start gap-3 py-3">
            <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <p className="type-label text-muted-foreground">
              Credits are non-refundable. For questions about billing or credits, please{' '}
              <Link href="mailto:hi@kilocode.ai" className="text-blue-400 hover:underline">
                contact support
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}

export default function CreditsPage() {
  return (
    <Suspense>
      <CreditsPageContent />
    </Suspense>
  );
}
