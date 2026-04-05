'use client';

import { Card, CardContent } from '@/components/ui/card';
import { X } from 'lucide-react';

type OrganizationTopupSuccessHeaderProps = {
  organizationName: string;
  amountUsd: string;
  onDismiss: () => void;
};

export function OrganizationTopupSuccessHeader({
  organizationName,
  amountUsd,
  onDismiss,
}: OrganizationTopupSuccessHeaderProps) {
  const formattedAmount = parseFloat(amountUsd).toFixed(2);
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
          <div className="flex flex-1 items-center">
            <h3 className="text-xl font-semibold text-green-100">
              You purchased ${formattedAmount} more credits for {organizationName}. Happy Coding!
            </h3>
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
