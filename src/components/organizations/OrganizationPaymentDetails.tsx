'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import type { OrganizationRole, TimePeriod } from '@/lib/organizations/organization-types';
import { OrganizationContextProvider } from './OrganizationContext';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationInvoicesCard } from './OrganizationInvoicesCard';
import { OrganizationAutoTopUpToggle } from './OrganizationAutoTopUpToggle';
import { SpendingAlertsModal } from './SpendingAlertsModal';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { AnimatedDollars } from './AnimatedDollars';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  fromMicrodollars,
} from '@/lib/utils';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';
import { PiggyBank, Bell, ChevronRight, Clock } from 'lucide-react';
import Link from 'next/link';
import { subDays } from 'date-fns';
import { useTRPC } from '@/lib/trpc/utils';

type Props = {
  organizationId: string;
  role: OrganizationRole;
};

export function OrganizationPaymentDetails({ organizationId, role }: Props) {
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('year');
  const [isSpendingAlertsModalOpen, setIsSpendingAlertsModalOpen] = useState(false);
  const userRole = role;
  const session = useSession();
  const isKiloAdmin = session?.data?.isAdmin ?? false;
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const trpc = useTRPC();
  const { data: creditBlocksData } = useQuery(
    trpc.organizations.getCreditBlocks.queryOptions({ organizationId })
  );

  const expiringBlocks =
    creditBlocksData?.creditBlocks.filter(
      block => block.expiry_date !== null && block.balance_mUsd > 0
    ) ?? [];
  const expiring_mUsd = expiringBlocks.reduce((sum, block) => sum + block.balance_mUsd, 0);
  const earliestExpiry = expiringBlocks
    .map(block => block.expiry_date)
    .filter((date): date is string => date !== null)
    .sort()[0];

  return (
    <OrganizationContextProvider value={{ userRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-8">
        <OrganizationPageHeader
          organizationId={organizationId}
          title={
            <div className="flex items-center gap-2">
              <Link
                href={`/organizations/${organizationId}`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Organization Details
              </Link>
              <ChevronRight className="text-muted-foreground h-5 w-5" />
              <span>Payment Details</span>
            </div>
          }
          showBackButton={false}
        />

        {/* Buy Credits and Auto Top-Up Section */}
        {isKiloAdmin && (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Buy Credits Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PiggyBank className="h-5 w-5" />
                  Balance & Credits
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-muted-foreground text-sm font-medium">
                    Current Balance{' '}
                  </span>
                  <div className="flex items-center gap-2">
                    <AnimatedDollars
                      dollars={fromMicrodollars(
                        (organizationData?.total_microdollars_acquired ?? 0) -
                          (organizationData?.microdollars_used ?? 0)
                      )}
                      className="text-2xl font-semibold"
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setIsSpendingAlertsModalOpen(true)}
                            className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                          >
                            <Bell className="text-muted-foreground hover:text-foreground h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Configure Low Balance Alert</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
                <CreditPurchaseOptions amounts={[100, 500, 1000]} organizationId={organizationId} />
              </CardContent>
            </Card>

            {/* Auto Top-Up Card */}
            <Card>
              <CardHeader>
                <CardTitle>Automatic Top-Up</CardTitle>
              </CardHeader>
              <CardContent>
                <OrganizationAutoTopUpToggle organizationId={organizationId} />
              </CardContent>
            </Card>
          </div>
        )}

        {expiringBlocks.length > 0 && earliestExpiry && (
          <Card>
            <CardContent className="flex items-center gap-2 py-3">
              <Clock className="h-4 w-4 shrink-0 text-amber-500" />
              <span className="text-sm">
                {formatDollars(fromMicrodollars(expiring_mUsd))} in credits expiring after{' '}
                {formatIsoDateString_UsaDateOnlyFormat(subDays(new Date(earliestExpiry), 1))}
              </span>
            </CardContent>
          </Card>
        )}

        <Tabs value={timePeriod} onValueChange={value => setTimePeriod(value as TimePeriod)}>
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-semibold">Payment History</h2>
            <TabsList>
              <TabsTrigger value="year">Past Year</TabsTrigger>
              <TabsTrigger value="all">All Time</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value={timePeriod} className="mt-6">
            <div className="flex w-full flex-col">
              <OrganizationInvoicesCard organizationId={organizationId} timePeriod={timePeriod} />
            </div>
          </TabsContent>
        </Tabs>
      </div>
      <SpendingAlertsModal
        open={isSpendingAlertsModalOpen}
        onOpenChange={setIsSpendingAlertsModalOpen}
        organizationId={organizationId}
        settings={organizationData?.settings}
      />
    </OrganizationContextProvider>
  );
}
