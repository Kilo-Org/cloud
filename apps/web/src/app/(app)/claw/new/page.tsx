'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { ClawGettingStarted } from '../components/ClawGettingStarted';
import { WelcomePage } from '../components/billing/WelcomePage';

export default function ClawNewPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const statusQuery = useKiloClawStatus();
  const { data: billing } = billingQuery;
  const { data: status, isLoading: statusLoading } = statusQuery;

  const hasInstance = !!status?.status || billing?.instance != null;

  useEffect(() => {
    if (!billingQuery.isLoading && !statusLoading && hasInstance) {
      router.replace('/claw/chat');
    }
  }, [hasInstance, billingQuery.isLoading, statusLoading, router]);

  if (billingQuery.isLoading || statusLoading || hasInstance) {
    return null;
  }

  if (billingQuery.isError) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <p className="text-destructive text-sm">
          Unable to load billing status. Please refresh the page or try again later.
        </p>
      </div>
    );
  }

  const isNewUser =
    billing &&
    !billing.hasAccess &&
    billing.instance === null &&
    !billing.earlybird &&
    !billing.trial?.expired;

  if (isNewUser) {
    if (billing.trialEligible) {
      return <ClawGettingStarted status={status} isNewSetup={false} onNewSetupChange={() => {}} />;
    }
    return <WelcomePage />;
  }

  return <ClawGettingStarted status={status} isNewSetup={false} onNewSetupChange={() => {}} />;
}
