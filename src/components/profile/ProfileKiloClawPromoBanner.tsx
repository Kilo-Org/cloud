'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePostHog } from 'posthog-js/react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import KiloCrabIcon from '@/components/KiloCrabIcon';

export function ProfileKiloClawPromoBanner() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const posthog = usePostHog();

  if (billingQuery.isLoading) {
    return (
      <div className="flex w-full items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/5 p-6">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  const billing = billingQuery.data;
  if (billingQuery.isError || !billing) {
    return null;
  }

  const hasInstance = billing.instance !== null && billing.instance.exists;

  if (hasInstance) {
    return null;
  }

  return (
    <div className="flex w-full items-center gap-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/20">
        <KiloCrabIcon className="h-5 w-5 text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-blue-100">Get KiloClaw</p>
        <p className="text-sm text-blue-300/80">
          Deploy your own AI coding agent in the cloud. Set up your instance in minutes.
        </p>
      </div>
      <Button
        asChild
        variant="outline"
        className="shrink-0 border-blue-500/40 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100"
        onClick={() => posthog?.capture('kiloclaw_promo_banner_clicked')}
      >
        <Link href="/claw">
          Get Started
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}
