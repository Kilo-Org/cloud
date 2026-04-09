'use client';

import { CreditCard } from 'lucide-react';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { BillingWrapper } from './billing/BillingWrapper';
import { SubscriptionTab } from './SubscriptionTab';

export function ClawSubscriptionPage() {
  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <SetPageTitle
        title="Subscription"
        icon={<CreditCard className="text-muted-foreground h-4 w-4" />}
      />
      <BillingWrapper>
        <Card>
          <CardContent className="p-5">
            <SubscriptionTab />
          </CardContent>
        </Card>
      </BillingWrapper>
    </div>
  );
}
