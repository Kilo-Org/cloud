'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
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
        icon={<KiloCrabIcon className="h-5 w-5 sm:h-6 sm:w-6 text-emerald-400" />}
        title="Your KiloClaw instance is active"
        description="Manage your instance, configure integrations, and monitor your Claw."
        colors={{
          border: 'border-emerald-500/30',
          bg: 'bg-emerald-500/10',
          text: 'text-emerald-400',
        }}
        action={
          <Button
            asChild
            className="w-full shrink-0 bg-emerald-500 text-primary-foreground hover:bg-emerald-500/90 sm:w-auto"
          >
            <Link href="/claw">
              Go to KiloClaw
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      />
    );
  }

  if (hasInstance && !billing.hasAccess) {
    return (
      <Banner
        icon={<AlertTriangle className="h-5 w-5 sm:h-6 sm:w-6 text-amber-400" />}
        title="Your KiloClaw instance needs attention"
        description="Your access has lapsed. Visit the dashboard to resolve billing and restore your instance."
        colors={{
          border: 'border-amber-500/30',
          bg: 'bg-amber-500/10',
          text: 'text-amber-400',
        }}
        action={
          <Button
            asChild
            className="w-full shrink-0 bg-amber-500 text-primary-foreground hover:bg-amber-500/90 sm:w-auto"
          >
            <Link href="/claw">
              Resolve
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <Banner
      icon={<KiloCrabIcon className="h-5 w-5 sm:h-6 sm:w-6 text-blue-400" />}
      title="Get started with KiloClaw"
      description="Fully-managed OpenClaw, always online. Set up in minutes."
      colors={{
        border: 'border-blue-500/30',
        bg: 'bg-blue-500/10',
        text: 'text-blue-400',
      }}
      action={
        <Button
          asChild
          className="w-full shrink-0 bg-blue-500 text-primary-foreground hover:bg-blue-500/90 sm:w-auto"
        >
          <Link href="/claw">
            Get Started
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      }
    />
  );
}
