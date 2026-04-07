'use client';

import { Sparkles } from 'lucide-react';
import { ClawContextProvider } from './ClawContext';
import { ChangelogTab } from './ChangelogTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

export function ClawChangelogPage({ organizationId }: { organizationId?: string }) {
  const changelogContent = (
    <Card>
      <CardContent className="p-5">
        <ChangelogTab />
      </CardContent>
    </Card>
  );

  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle
          title="What's New"
          icon={<Sparkles className="text-muted-foreground h-4 w-4" />}
        />
        {!organizationId ? <BillingWrapper>{changelogContent}</BillingWrapper> : changelogContent}
      </div>
    </ClawContextProvider>
  );
}
