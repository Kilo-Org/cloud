'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import {
  toCurrentAllocations,
  toOrgKiloPassTerms,
} from '@/components/subscriptions/org-kilo-pass/mappers';
import type { OrgKiloPassAllocation } from '@/components/subscriptions/org-kilo-pass/types';
import { CurrentAllocationTable } from '@/components/subscriptions/org-kilo-pass/view-shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';

type Props = {
  organizationId: string;
};

export function KiloPassUsageCard({ organizationId }: Props) {
  const trpc = useTRPC();
  const usageQuery = useQuery(trpc.organizations.kiloPass.usage.queryOptions({ organizationId }));

  if (usageQuery.isPending) {
    return (
      <LoadingCard
        title="Kilo Pass Usage"
        description="Loading Kilo Pass usage information..."
        rowCount={2}
      />
    );
  }
  if (usageQuery.isError) {
    return (
      <ErrorCard
        title="Kilo Pass Usage"
        description="Error loading Kilo Pass usage information"
        error={usageQuery.error}
        onRetry={() => void usageQuery.refetch()}
      />
    );
  }
  if (!usageQuery.data) return null;

  return (
    <KiloPassUsageCardView
      organizationId={organizationId}
      allocations={toCurrentAllocations(usageQuery.data.currentAllocations)}
      fullMonthlyCreditsPerPassUsd={toOrgKiloPassTerms(usageQuery.data).baseCreditsPerPassUsd}
    />
  );
}

export function KiloPassUsageCardView({
  organizationId,
  allocations,
  fullMonthlyCreditsPerPassUsd,
}: {
  organizationId: string;
  allocations: OrgKiloPassAllocation[];
  fullMonthlyCreditsPerPassUsd: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KiloPassIcon className="size-4" />
              Kilo Pass Usage
            </CardTitle>
            <CardDescription className="mt-1">
              Current monthly Credits and bonus progress by organization.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={`/organizations/${organizationId}/subscriptions/kilo-pass`}>
              Manage Subscription
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <CurrentAllocationTable
          allocations={allocations}
          fullMonthlyCreditsPerPassUsd={fullMonthlyCreditsPerPassUsd}
        />
      </CardContent>
    </Card>
  );
}
