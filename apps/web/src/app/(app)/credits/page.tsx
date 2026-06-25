'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Info, X, CheckCircle2, CalendarDays, ExternalLink, ChevronRight } from 'lucide-react';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';
import { useTRPC } from '@/lib/trpc/utils';
import { TRPCClientError } from '@trpc/client';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { AutoTopUpToggle } from '@/components/payment/AutoTopUpToggle';
import { TOPUP_AMOUNT_QUERY_STRING_KEY } from '@/lib/organizations/constants';

// Shared table header cell — applies the canonical eyebrow type utility.
function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`type-eyebrow text-muted-foreground px-6 py-3 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

// Shared table body cell — applies the canonical body type utility.
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
      className={`type-body px-6 py-3 whitespace-nowrap ${align === 'right' ? 'text-right' : ''} ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

export default function CreditsPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const searchParams = useSearchParams();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const {
    data: creditData,
    isLoading,
    error,
    refetch,
  } = useQuery(trpc.user.getCreditBlocks.queryOptions({}));

  useEffect(() => {
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      router.push('/users/sign_in?callbackPath=/credits');
    }
  }, [error, router]);

  const headerActions = (
    <Link
      href="/subscriptions"
      className="type-body flex items-center gap-1 text-blue-400 hover:underline"
    >
      Manage subscriptions <ChevronRight className="size-4" />
    </Link>
  );

  if (isLoading) {
    return (
      <PageLayout
        title="Credits"
        subtitle="Buy credits, view your balance, and manage auto top-up."
        headerActions={headerActions}
      >
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <Skeleton className="h-8 w-36" />
              <Skeleton className="h-4 w-24 mt-1" />
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
              <Skeleton className="h-4 w-64 mt-1" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted border-b">
                      <Th>Purchase Date</Th>
                      <Th>Credits Added</Th>
                      <Th>Expiration Date</Th>
                      <Th>Invoice</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i} className="even:bg-muted group">
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-20" />
                        </Td>
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-16" />
                        </Td>
                        <Td>
                          <Skeleton className="group-even:bg-background h-4 w-20" />
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

  const blocks = [...creditData.creditBlocks].sort(
    (a, b) => new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
  );
  const latest = blocks[0];
  const currentBalance = creditData.totalBalance_mUsd;
  const creditsPurchased = latest?.amount_mUsd ?? 0;
  const previousBalance = Math.max(currentBalance - creditsPurchased, 0);
  const latestExpiry = latest?.expiry_date ?? null;

  const purchasedParam = searchParams.get(TOPUP_AMOUNT_QUERY_STRING_KEY);
  const showBanner = purchasedParam != null && !bannerDismissed;

  return (
    <PageLayout
      title="Credits"
      subtitle="Buy credits, view your balance, and manage auto top-up."
      headerActions={headerActions}
    >
      <div className="flex flex-col gap-6">
        {/* Post-purchase confirmation banner */}
        {showBanner && (
          <Card className="border-green-500/20 bg-green-500/10">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-400" />
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-10">
                    <div>
                      <p className="type-heading text-green-400">
                        ${Number(purchasedParam).toFixed(2)} in credits added
                      </p>
                      <p className="type-body text-muted-foreground mt-0.5 tabular-nums">
                        Previous balance {formatMicrodollars(previousBalance)} + $
                        {Number(purchasedParam).toFixed(2)} = New balance{' '}
                        {formatMicrodollars(currentBalance)}
                      </p>
                    </div>
                    {latestExpiry && (
                      <div className="flex items-center gap-1.5">
                        <CalendarDays className="size-4 text-blue-400 shrink-0" />
                        <span className="type-body text-muted-foreground">
                          These credits expire on
                        </span>
                        <span className="type-body font-medium text-blue-400">
                          {formatIsoDateString_UsaDateOnlyFormat(latestExpiry)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setBannerDismissed(true)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Balance summary */}
        <Card>
          <CardHeader>
            <CardTitle>Your credit balance</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1px_1fr_1px_1fr]">
              {/* Current balance KPI */}
              <div>
                <div className="type-title tabular-nums text-green-400">
                  {formatMicrodollars(currentBalance)}
                </div>
                <div className="type-label text-muted-foreground mt-1">available</div>
              </div>

              <div className="hidden lg:block w-px bg-border self-stretch" />

              {/* Breakdown */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="type-body text-muted-foreground">Previous balance</span>
                  <span className="type-body tabular-nums">
                    {formatMicrodollars(previousBalance)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="type-body text-muted-foreground">Credits purchased</span>
                  <span className="type-body tabular-nums font-medium text-green-400">
                    +{formatMicrodollars(creditsPurchased)}
                  </span>
                </div>
                <div className="border-t border-border" />
                <div className="flex items-center justify-between gap-4">
                  <span className="type-body font-semibold">Current balance</span>
                  <span className="type-body tabular-nums font-semibold">
                    {formatMicrodollars(currentBalance)}
                  </span>
                </div>
              </div>

              <div className="hidden lg:block w-px bg-border self-stretch" />

              {/* Expiry info */}
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 text-blue-400 shrink-0" />
                <div>
                  <p className="type-body text-muted-foreground">Latest purchase expires on</p>
                  {latestExpiry ? (
                    <p className="type-body font-medium text-blue-400">
                      {formatIsoDateString_UsaDateOnlyFormat(latestExpiry)}
                    </p>
                  ) : (
                    <p className="type-body font-medium">Never</p>
                  )}
                </div>
              </div>
            </div>

            <div className="type-label text-muted-foreground border-t border-border pt-4">
              Credit expiration applies to each purchase. Credits expire at 11:59 PM (UTC) on the
              expiration date.
            </div>
          </CardContent>
        </Card>

        {/* Buy Credits */}
        <CreditPurchaseOptions isFirstPurchase={creditData.isFirstPurchase} />

        {/* Automatic Top Up */}
        <Card>
          <CardHeader>
            <CardTitle>Automatic Top Up</CardTitle>
          </CardHeader>
          <CardContent>
            <AutoTopUpToggle />
          </CardContent>
        </Card>

        {/* Credit history */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Credit history</CardTitle>
            <CardDescription>A record of your credit purchases.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <Th>Purchase Date</Th>
                    <Th>Credits Added</Th>
                    <Th>Expiration Date</Th>
                    <Th>Invoice</Th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {blocks.map(block => (
                    <tr key={block.id} className="even:bg-muted">
                      <Td>{formatIsoDateString_UsaDateOnlyFormat(block.effective_date)}</Td>
                      <Td numeric>{formatMicrodollars(block.amount_mUsd)}</Td>
                      <Td>
                        {block.expiry_date ? (
                          <Link
                            href={`https://countdown.val.run/?time=${new Date(block.expiry_date).toISOString()}`}
                            className="text-blue-400 hover:underline"
                            target="_blank"
                            prefetch={false}
                            title={`${new Date(block.expiry_date).toLocaleDateString()} ${new Date(block.expiry_date).toLocaleTimeString()}`}
                          >
                            {formatIsoDateString_UsaDateOnlyFormat(block.expiry_date)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </Td>
                      <Td>
                        {block.receipt_url ? (
                          <Link
                            href={block.receipt_url}
                            className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                            target="_blank"
                            prefetch={false}
                          >
                            View invoice <ExternalLink className="size-3" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {blocks.length === 0 && (
              <div className="type-body text-muted-foreground px-6 py-12 text-center">
                No credit purchases yet.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Credit Subscription Transactions */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Credit Subscription Transactions</CardTitle>
            <CardDescription>
              Credits spent on subscriptions and recurring expenses.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {creditData.deductions.map(deduction => (
                    <tr key={deduction.id} className="even:bg-muted">
                      <Td>{formatIsoDateString_UsaDateOnlyFormat(deduction.date)}</Td>
                      <Td className="whitespace-normal">{deduction.description}</Td>
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
                No subscription transactions yet.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Disclaimer */}
        <Card>
          <CardContent className="flex items-start gap-3 py-3">
            <Info className="mt-0.5 size-4 text-muted-foreground shrink-0" />
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
