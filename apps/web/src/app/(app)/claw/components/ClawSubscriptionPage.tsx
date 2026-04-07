'use client';

import { CreditCard } from 'lucide-react';
import { ClawContextProvider } from './ClawContext';
import { SubscriptionTab } from './SubscriptionTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

export function ClawSubscriptionPage() {
  return (
    <ClawContextProvider organizationId={undefined}>
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
    </ClawContextProvider>
  );
}
