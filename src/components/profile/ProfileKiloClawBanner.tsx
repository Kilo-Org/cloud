'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import KiloCrabIcon from '@/components/KiloCrabIcon';

export function ProfileKiloClawBanner() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());

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

  if (hasInstance && billing.hasAccess) {
    return (
      <div className="flex w-full items-center gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/20">
          <KiloCrabIcon className="h-5 w-5 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-emerald-100">Your KiloClaw instance is active</p>
          <p className="text-sm text-emerald-300/80">
            Manage your instance, configure integrations, and monitor your Claw.
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="shrink-0 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/20 hover:text-emerald-100"
        >
          <Link href="/claw">
            Go to KiloClaw
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    );
  }

  if (hasInstance && !billing.hasAccess) {
    return (
      <div className="flex w-full items-center gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/20">
          <AlertTriangle className="h-5 w-5 text-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-100">
            Your KiloClaw instance needs attention
          </p>
          <p className="text-sm text-amber-300/80">
            Your access has lapsed. Visit the dashboard to resolve billing and restore your
            instance.
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="shrink-0 border-amber-500/40 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
        >
          <Link href="/claw">
            Resolve
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/20">
        <KiloCrabIcon className="h-5 w-5 text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-blue-100">Get started with KiloClaw</p>
        <p className="text-sm text-blue-300/80">
          Fully-managed OpenClaw, always online. Set up in minutes.
        </p>
      </div>
      <Button
        asChild
        variant="outline"
        className="shrink-0 border-blue-500/40 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100"
      >
        <Link href="/claw">
          Get Started
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}
