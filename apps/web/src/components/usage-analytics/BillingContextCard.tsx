'use client';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditCard } from 'lucide-react';
import { formatDollars } from '@/lib/utils';

type BillingContextCardProps = {
  context: 'personal' | 'organization';
  organizationId?: string;
};

/**
 * Shows current billing period context:
 * - Personal: Kilo Pass usage vs. allowance.
 * - Organization: Current balance and monthly acquisition.
 */
export function BillingContextCard({ context, organizationId }: BillingContextCardProps) {
  const trpc = useTRPC();

  const { data: kiloPassState, isLoading: kiloPassLoading } = useQuery({
    ...trpc.kiloPass.getState.queryOptions(),
    enabled: context === 'personal',
  });

  const { data: orgData, isLoading: orgLoading } = useQuery({
    ...trpc.organizations.withMembers.queryOptions({
      organizationId: organizationId ?? '00000000-0000-0000-0000-000000000000',
    }),
    enabled: context === 'organization' && !!organizationId,
  });

  if (context === 'personal') {
    const sub = kiloPassState?.subscription;
    const loading = kiloPassLoading;

    if (loading) {
      return <BillingCardSkeleton title="Kilo Pass" />;
    }

    if (!sub) {
      return (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Billing
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="text-muted-foreground text-sm">No Kilo Pass subscription.</div>
          </CardContent>
        </Card>
      );
    }

    const used = sub.currentPeriodUsageUsd;
    const base = sub.currentPeriodBaseCreditsUsd;
    const bonus = sub.currentPeriodBonusCreditsUsd ?? 0;
    const total = base + bonus;
    const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;

    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Kilo Pass
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0 pb-3">
          <div className="text-xl font-bold">
            {formatDollars(used)}
            <span className="text-muted-foreground text-sm font-normal">
              {' '}
              / {formatDollars(total)}
            </span>
          </div>
          <Progress value={percent} />
          {sub.refillAt && (
            <div className="text-muted-foreground text-xs">
              Refills on {new Date(sub.refillAt).toLocaleDateString()}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Organization context
  if (orgLoading) {
    return <BillingCardSkeleton title="Organization Balance" />;
  }
  if (!orgData) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Organization Balance
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2">
          <div className="text-muted-foreground text-sm">Balance unavailable.</div>
        </CardContent>
      </Card>
    );
  }
  const total = orgData.total_microdollars_acquired;
  const used = orgData.microdollars_used;
  const balance = total - used;
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          Organization Balance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0 pb-3">
        <div className="text-xl font-bold">
          {formatDollars(balance / 1_000_000)}
          <span className="text-muted-foreground text-sm font-normal">
            {' '}
            / {formatDollars(total / 1_000_000)}
          </span>
        </div>
        <Progress value={100 - percent} />
        <div className="text-muted-foreground text-xs">
          {formatDollars(used / 1_000_000)} used this period
        </div>
      </CardContent>
    </Card>
  );
}

function BillingCardSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0 pb-3">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  );
}
