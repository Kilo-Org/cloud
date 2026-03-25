'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, AlertTriangle } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Banner } from '@/components/shared/Banner';

export function ProfileKiloClawBanner() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());

  if (billingQuery.isLoading) {
    return (
      <div className="flex w-full items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  const billing = billingQuery.data;
  if (billingQuery.isError || !billing) {
    return null;
  }

  const hasInstance = billing.instance !== null && billing.instance.exists;

  if (hasInstance && billing.hasAccess) {
    return (
      <Banner
        icon={KiloCrabIcon}
        color="emerald"
        title="Your KiloClaw instance is active"
        description="Manage your instance, configure integrations, and monitor your Claw."
        buttonLabel="Go to KiloClaw"
        buttonHref="/claw"
        buttonIcon={ArrowRight}
      />
    );
  }

  if (hasInstance && !billing.hasAccess) {
    return (
      <Banner
        icon={AlertTriangle}
        color="amber"
        title="Your KiloClaw instance needs attention"
        description="Your access has lapsed. Visit the dashboard to resolve billing and restore your instance."
        buttonLabel="Resolve"
        buttonHref="/claw"
        buttonIcon={ArrowRight}
      />
    );
  }

  return (
    <Banner
      icon={KiloCrabIcon}
      color="blue"
      title="Get started with KiloClaw"
      description="Fully-managed OpenClaw, always online. Set up in minutes."
      buttonLabel="Get Started"
      buttonHref="/claw"
    />
  );
}
