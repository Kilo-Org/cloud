'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins, CreditCard } from 'lucide-react';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';
import { useTRPC } from '@/lib/trpc/utils';
import { TRPCClientError } from '@trpc/client';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { AutoTopUpToggle } from '@/components/payment/AutoTopUpToggle';

export default function CreditsPage() {
  const router = useRouter();
  const trpc = useTRPC();

  const {
    data: creditData,
    isLoading,
    error,
    refetch,
  } = useQuery(trpc.user.getCreditBlocks.queryOptions({}));

  // Redirect to sign-in page if user is not authenticated
  useEffect(() => {
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      router.push('/users/sign_in?callbackPath=/credits');
    }
  }, [error, router]);

  if (isLoading) {
    return (
      <PageLayout title="Credits">
        <Card className="w-full overflow-hidden">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Skeleton className="h-6 w-6 rounded-full" />
                <div>
                  <Skeleton className="h-6 w-64" />
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Effective Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Expiry Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Current Balance
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Original Balance
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
                        <Skeleton className="group-even:bg-background h-5 w-20" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="group-even:bg-background h-5 w-16" />
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
      </PageLayout>
    );
  }

  if (error) {
    // If it's an unauthorized error, show loading while redirecting
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

  const displayedCreditBlocks = creditData.creditBlocks;

  return (
    <PageLayout title="Credits">
      <CreditPurchaseOptions isFirstPurchase={creditData.isFirstPurchase} />

      <Card className="w-full text-left">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Automatic Top Up
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AutoTopUpToggle />
        </CardContent>
      </Card>

      <Card className="w-full overflow-hidden">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Coins className="text-muted-foreground h-6 w-6" />
              <div>
                <CardTitle className="text-xl">
                  Credit balance: {formatMicrodollars(creditData.totalBalance_mUsd, 6)}
                </CardTitle>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-muted border-b">
                  <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                    Effective Date
                  </th>
                  <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                    Expiry Date
                  </th>
                  <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                    Current Balance
                  </th>
                  <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                    Original Balance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {displayedCreditBlocks.map(block => (
                  <tr key={block.id} className={`even:bg-muted text-foreground`}>
                    <td className="px-6 py-4 text-sm whitespace-nowrap">
                      {formatIsoDateString_UsaDateOnlyFormat(block.effective_date)}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap">
                      {block.expiry_date ? (
                        <Link
                          href={`https://countdown.val.run/?time=${new Date(block.expiry_date).toISOString()}`}
                          className="hover:text-muted-foreground"
                          target="_blank"
                          prefetch={false}
                          title={`${new Date(block.expiry_date).toLocaleDateString()} ${new Date(block.expiry_date).toLocaleTimeString()}`}
                        >
                          {formatIsoDateString_UsaDateOnlyFormat(block.expiry_date)}
                        </Link>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap">
                      {formatMicrodollars(block.balance_mUsd, 6)}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap">
                      {formatMicrodollars(block.amount_mUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {displayedCreditBlocks.length === 0 && (
            <div className="text-muted-foreground px-6 py-12 text-center">
              No credit blocks found
            </div>
          )}
        </CardContent>
      </Card>

      {creditData.deductions.length > 0 && (
        <Card className="w-full overflow-hidden">
          <CardHeader>
            <div className="flex items-center gap-3">
              <CreditCard className="text-muted-foreground h-6 w-6" />
              <CardTitle className="text-xl">Credit Subscription Transactions</CardTitle>
            </div>
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
          </CardContent>
        </Card>
      )}
    </PageLayout>
  );
}
