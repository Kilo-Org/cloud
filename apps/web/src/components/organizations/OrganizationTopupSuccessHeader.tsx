'use client';

import { Card, CardContent } from '@/components/ui/card';
import { X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { TOPUP_TRANSACTION_QUERY_STRING_KEY } from '@kilocode/web-shared/lib/organizations/constants';
import { z } from 'zod';

type OrganizationTopupSuccessHeaderProps = {
  organizationName: string;
  organizationId: string;
  amountUsd: string;
  onDismiss: () => void;
};

export function OrganizationTopupSuccessHeader({
  organizationName,
  organizationId,
  amountUsd,
  onDismiss,
}: OrganizationTopupSuccessHeaderProps) {
  const formattedAmount = parseFloat(amountUsd).toFixed(2);
  const trpc = useTRPC();
  const searchParams = useSearchParams();
  const transactionId = searchParams.get(TOPUP_TRANSACTION_QUERY_STRING_KEY) ?? '';
  const { data: confirmation } = useQuery(
    trpc.user.getCreditPurchaseConfirmation.queryOptions(
      { transactionId, organizationId },
      { enabled: z.uuid().safeParse(transactionId).success, retry: false }
    )
  );
  return (
    <Card className="border-green-900 bg-green-950/30">
      <CardContent className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-900/50">
              <svg
                className="h-6 w-6 text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <div className="flex-1 space-y-1">
            <h3 className="text-xl font-semibold text-green-100">
              You purchased ${formattedAmount} in credits for {organizationName}.
            </h3>
            {confirmation && (
              <p className="text-muted-foreground text-sm">
                {confirmation.expiryDate
                  ? `Purchased credits expire ${new Date(confirmation.expiryDate).toLocaleString(
                      'en-US',
                      { timeZone: 'UTC', timeZoneName: 'short' }
                    )}.`
                  : 'These purchased credits do not expire.'}
              </p>
            )}
          </div>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="shrink-0 rounded-full p-1 text-green-400 hover:bg-green-900/50 hover:text-green-300 focus:ring-2 focus:ring-green-400 focus:ring-green-500 focus:outline-none"
            aria-label="Dismiss topup success message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
