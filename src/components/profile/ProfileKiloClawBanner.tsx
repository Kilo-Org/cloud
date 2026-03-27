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
      <Banner color="emerald">
        <Banner.Icon>
          <KiloCrabIcon />
        </Banner.Icon>
        <Banner.Content>
          <Banner.Title>Your KiloClaw instance is active</Banner.Title>
          <Banner.Description>
            Manage your instance, configure integrations, and monitor your Claw.
          </Banner.Description>
        </Banner.Content>
        <Banner.Button href="/claw">
          Go to KiloClaw
          <ArrowRight />
        </Banner.Button>
      </Banner>
    );
  }

  if (hasInstance && !billing.hasAccess) {
    return (
      <Banner color="amber">
        <Banner.Icon>
          <AlertTriangle />
        </Banner.Icon>
        <Banner.Content>
          <Banner.Title>Your KiloClaw instance needs attention</Banner.Title>
          <Banner.Description>
            Your access has lapsed. Visit the dashboard to resolve billing and restore your
            instance.
          </Banner.Description>
        </Banner.Content>
        <Banner.Button href="/claw">
          Resolve
          <ArrowRight />
        </Banner.Button>
      </Banner>
    );
  }

  return (
    <Banner color="blue">
      <Banner.Icon>
        <KiloCrabIcon />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Get started with KiloClaw</Banner.Title>
        <Banner.Description>
          Fully-managed OpenClaw, always online. Set up in minutes.
        </Banner.Description>
      </Banner.Content>
      <Banner.Button href="/claw">Get Started</Banner.Button>
    </Banner>
  );
}
