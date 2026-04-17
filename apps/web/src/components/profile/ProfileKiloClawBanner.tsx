'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, AlertTriangle } from 'lucide-react';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useTRPC } from '@/lib/trpc/utils';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Banner } from '@/components/shared/Banner';

type ProfileKiloClawBannerVariant =
  | 'loading'
  | 'active'
  | 'continue-setup'
  | 'needs-attention'
  | 'get-started';

export function getProfileKiloClawBannerVariant(params: {
  billingLoading: boolean;
  hasBilling: boolean;
  hasInstance: boolean;
  activeInstanceHasAccess: boolean;
  statusLoading: boolean;
  statusError: boolean;
  status: string | null | undefined;
}): ProfileKiloClawBannerVariant {
  if (params.billingLoading) {
    return 'loading';
  }

  if (!params.hasBilling) {
    return 'get-started';
  }

  if (params.hasInstance && params.activeInstanceHasAccess) {
    if (params.statusLoading) {
      return 'loading';
    }

    if (!params.statusError && params.status === null) {
      return 'continue-setup';
    }

    return 'active';
  }

  if (params.hasInstance) {
    return 'needs-attention';
  }

  return 'get-started';
}

export function ProfileKiloClawBanner() {
  const trpc = useTRPC();
  const summaryQuery = useQuery(trpc.kiloclaw.getPersonalBillingSummary.queryOptions());
  const statusQuery = useKiloClawStatus();

  const billing = summaryQuery.data;
  const variant = getProfileKiloClawBannerVariant({
    billingLoading: summaryQuery.isLoading,
    hasBilling: !!billing && !summaryQuery.isError,
    hasInstance: billing?.hasActiveInstance ?? false,
    activeInstanceHasAccess: billing?.activeInstanceHasAccess ?? false,
    statusLoading: statusQuery.isLoading,
    statusError: !!statusQuery.isError,
    status: statusQuery.data?.status,
  });

  if (variant === 'loading') {
    return (
      <div className="flex w-full items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (summaryQuery.isError || !billing) {
    return null;
  }

  if (variant === 'active') {
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

  if (variant === 'continue-setup') {
    return (
      <Banner color="blue">
        <Banner.Icon>
          <KiloCrabIcon />
        </Banner.Icon>
        <Banner.Content>
          <Banner.Title>Finish setting up your KiloClaw instance</Banner.Title>
          <Banner.Description>
            Your KiloClaw instance has not yet been set up. Continue setup now to launch your Claw.
          </Banner.Description>
        </Banner.Content>
        <Banner.Button href="/claw/new">
          Continue Setup
          <ArrowRight />
        </Banner.Button>
      </Banner>
    );
  }

  if (variant === 'needs-attention') {
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
