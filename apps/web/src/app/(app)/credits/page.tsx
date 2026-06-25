'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  if (isLoading) {
    return (
      <PageLayout
        title="Credits"
        subtitle="Buy credits, view your balance, and manage auto top-up."
        headerActions={
          <Link
            href="/subscriptions"
            className="flex items-center gap-1 text-sm text-blue-400 hover:underline"
          >
            Manage subscriptions <ChevronRight className="h-4 w-4" />
          </Link>
        }
      >
        <div className="flex flex-col gap-6">
          <Card className="w-full overflow-hidden">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <Skeleton className="h-6 w-48" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Skeleton className="h-12 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardContent>
          </Card>

          <Card className="w-full overflow-hidden">
            <CardHeader>
              <Skeleton className="h-6 w-48" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-24 w-full rounded-lg" />
            </CardContent>
          </Card>

          <Card className="w-full overflow-hidden">
            <CardHeader>
              <Skeleton className="h-6 w-48" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-20 w-full rounded-lg" />
            </CardContent>
          </Card>

          <Card className="w-full overflow-hidden">
            <CardHeader>
              <Skeleton className="h-6 w-64" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted border-b">
                      <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                        Purchase Date
                      </th>
                      <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                        Credits Added
                      </th>
                      <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                        Expiration Date
                      </th>
                      <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                        Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <tr key={index} className="even:bg-muted group">
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <Skeleton className="group-even:bg-background h-5 w-20" />
                        </td>
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <Skeleton className="group-even:bg-background h-5 w-16" />
                        </td>
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <Skeleton className="group-even:bg-background h-5 w-20" />
                        </td>
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <Skeleton className="group-even:bg-background h-5 w-16" />
                        </td>
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
            <div className="text-muted-foreground text-lg">Redirecting to sign in...</div>
          </div>
        </PageLayout>
      );
    }

    return (
      <PageLayout title="Credits">
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <div className="text-destructive text-lg">
            Error: {error instanceof TRPCClientError ? error.message : 'An error occurred'}
          </div>
          <Button onClick={() => refetch()} variant="outline">
            Try Again
          </Button>
        </div>
      </PageLayout>
    );
  }

  if (!creditData) {
    return (
      <PageLayout title="Credits">
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground text-lg">No credit data available</div>
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
      headerActions={
        <Link
          href="/subscriptions"
          className="flex items-center gap-1 text-sm text-blue-400 hover:underline"
        >
          Manage subscriptions <ChevronRight className="h-4 w-4" />
        </Link>
      }
    >
      <div className="flex flex-col gap-6">
        {showBanner && (
          <Card className="border-green-600/40 bg-green-950/30">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-400 shrink-0" />
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-12">
                    <div>
                      <div className="text-lg font-semibold text-green-400">
                        ${Number(purchasedParam).toFixed(2)} in credits added
                      </div>
                      <div className="text-muted-foreground text-sm">
                        Previous balance {formatMicrodollars(previousBalance)} + $
                        {Number(purchasedParam).toFixed(2)} purchase = New balance{' '}
                        {formatMicrodollars(currentBalance)}
                      </div>
                    </div>
                    {latestExpiry && (
                      <div className="flex items-center gap-2 text-sm">
                        <CalendarDays className="h-4 w-4 text-blue-400" />
                        <span className="text-muted-foreground">These credits expire on</span>
                        <span className="font-medium text-blue-400">
                          {formatIsoDateString_UsaDateOnlyFormat(latestExpiry)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setBannerDismissed(true)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-medium">Your credit balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto_1fr] lg:grid-cols-[1fr_1px_1fr_1px_1fr]">
              <div>
                <div className="text-4xl font-bold text-green-500">
                  {formatMicrodollars(currentBalance)}
                </div>
                <div className="text-muted-foreground mt-1 text-sm">available</div>
              </div>

              <div className="hidden lg:block w-px bg-border self-stretch" />

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Previous balance</span>
                  <span>{formatMicrodollars(previousBalance)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Credits purchased</span>
                  <span className="font-medium text-green-500">
                    +{formatMicrodollars(creditsPurchased)}
                  </span>
                </div>
                <div className="my-1 border-t border-border" />
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span>Current balance</span>
                  <span>{formatMicrodollars(currentBalance)}</span>
                </div>
              </div>

              <div className="hidden lg:block w-px bg-border self-stretch" />

              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 text-blue-400 shrink-0" />
                <div className="text-sm">
                  <div className="text-muted-foreground">Your latest purchase expires on</div>
                  {latestExpiry ? (
                    <div className="font-medium text-blue-400">
                      {formatIsoDateString_UsaDateOnlyFormat(latestExpiry)}
                    </div>
                  ) : (
                    <div className="font-medium">Never</div>
                  )}
                </div>
              </div>
            </div>

            <div className="text-muted-foreground mt-4 border-t border-border pt-4 text-xs">
              Credit expiration applies to each purchase. Credits expire at 11:59 PM (UTC) on the
              expiration date.
            </div>
          </CardContent>
        </Card>

        <CreditPurchaseOptions isFirstPurchase={creditData.isFirstPurchase} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-medium">Automatic Top Up</CardTitle>
          </CardHeader>
          <CardContent>
            <AutoTopUpToggle />
          </CardContent>
        </Card>

        <Card className="w-full overflow-hidden">
          <CardHeader>
            <CardTitle className="text-lg font-medium">Credit history</CardTitle>
            <p className="text-muted-foreground text-sm">
              A detailed record of your credit purchases and balances.
            </p>
          </CardHeader>

          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Purchase Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Credits Added
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Expiration Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Invoice
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {blocks.map(block => (
                    <tr key={block.id} className="even:bg-muted text-foreground">
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        {formatIsoDateString_UsaDateOnlyFormat(block.effective_date)}
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        {formatMicrodollars(block.amount_mUsd)}
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
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
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        {block.receipt_url ? (
                          <Link
                            href={block.receipt_url}
                            className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                            target="_blank"
                            prefetch={false}
                          >
                            View invoice <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {blocks.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center">
                No credit blocks found
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="w-full overflow-hidden">
          <CardHeader>
            <CardTitle className="text-lg font-medium">Credit Subscription Transactions</CardTitle>
            <p className="text-muted-foreground text-sm">
              Credits spent on subscriptions and other recurring expenses.
            </p>
          </CardHeader>

          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Description
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-right text-xs font-medium tracking-wider uppercase">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {creditData.deductions.map(deduction => (
                    <tr key={deduction.id} className="even:bg-muted text-foreground">
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        {formatIsoDateString_UsaDateOnlyFormat(deduction.date)}
                      </td>
                      <td className="px-6 py-4 text-sm">{deduction.description}</td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap text-right">
                        -{formatMicrodollars(Math.abs(deduction.amount_mUsd))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {creditData.deductions.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center">
                No subscription transactions found
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="flex items-start gap-3 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 text-blue-400 shrink-0" />
            <p className="text-muted-foreground text-sm">
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
