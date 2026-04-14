'use client';

import { Sparkles } from 'lucide-react';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { ChangelogTab } from './ChangelogTab';
import { ClawConfigServiceBannerWithStatus } from './ClawConfigServiceBanner';
import { BillingWrapper } from './billing/BillingWrapper';

function ChangelogCard() {
  return (
    <Card>
      <CardContent className="p-5">
        <ChangelogTab />
      </CardContent>
    </Card>
  );
}

export function ClawChangelogPage({ organizationId }: { organizationId?: string }) {
  const content = (
    <>
      <ClawConfigServiceBannerWithStatus organizationId={organizationId} />
      <ChangelogCard />
    </>
  );

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <SetPageTitle
        title="What's New"
        icon={<Sparkles className="text-muted-foreground h-4 w-4" />}
      />
      {organizationId ? content : <BillingWrapper>{content}</BillingWrapper>}
    </div>
  );
}
