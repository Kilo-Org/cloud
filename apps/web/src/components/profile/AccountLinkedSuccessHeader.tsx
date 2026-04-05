'use client';

import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle, X } from 'lucide-react';

type AccountLinkedSuccessHeaderProps = {
  providerName: string;
  onDismiss: () => void;
};

export function AccountLinkedSuccessHeader({
  providerName,
  onDismiss,
}: AccountLinkedSuccessHeaderProps) {
  return (
    <Card className="border-green-900 bg-green-950/30">
      <CardContent className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-900/50">
              <CheckCircle className="h-6 w-6 text-green-400" />
            </div>
          </div>
          <div className="flex-1">
            <h3 className="mb-2 text-xl font-semibold text-green-100">
              Account Linked Successfully!
            </h3>
            <p className="text-green-200">
              Your {providerName} account has been successfully linked. You can now use this method
              to sign in to your account.
            </p>
          </div>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="focus:ring-green-400focus:outline-none shrink-0 rounded-full p-1 text-green-400 hover:bg-green-900/50 hover:text-green-300 focus:ring-2"
            aria-label="Dismiss success message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
