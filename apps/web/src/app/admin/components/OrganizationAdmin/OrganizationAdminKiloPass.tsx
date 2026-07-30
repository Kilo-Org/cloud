'use client';

import Link from 'next/link';
import { useAdminOrganizationKiloPassSummary } from '@/app/admin/api/organizations/hooks';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatOrgPassDate } from '@/components/subscriptions/org-kilo-pass/formatters';

export function OrganizationAdminKiloPass({ organizationId }: { organizationId: string }) {
  const summaryQuery = useAdminOrganizationKiloPassSummary(organizationId);

  if (summaryQuery.isPending) {
    return <Skeleton className="h-44 w-full rounded-xl" />;
  }

  if (summaryQuery.isError) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Kilo Pass for Organizations</CardTitle>
          <CardDescription>Unable to load the organization Kilo Pass subscription.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void summaryQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { agreement, managedByOrganization } = summaryQuery.data;
  const isManagedByParent = managedByOrganization.id !== organizationId;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <KiloPassIcon className="size-4" aria-hidden />
              Kilo Pass for Organizations
            </CardTitle>
            <CardDescription>
              {isManagedByParent
                ? 'This allocation is managed by the parent organization.'
                : 'Read-only subscription and processing information.'}
            </CardDescription>
          </div>
          {agreement ? (
            <Badge
              variant={
                agreement.processingCondition === 'blocked' ||
                agreement.processingCondition === 'failed' ||
                agreement.processingCondition === 'overallocated'
                  ? 'destructive'
                  : 'secondary-outline'
              }
            >
              {agreement.state.replace(/_/g, ' ')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {isManagedByParent ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="type-label text-muted-foreground">Managed by</p>
                <p className="type-body mt-1 font-medium">{managedByOrganization.name}</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/organizations/${managedByOrganization.id}`}>View parent</Link>
              </Button>
            </div>
            {agreement ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary-outline">
                  {agreement.tierName}
                </Badge>
                <span className="text-muted-foreground type-label">
                  {agreement.purchasedPassCapacity} passes · {agreement.state.replace(/_/g, ' ')}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground type-body">
                The parent organization does not have a Kilo Pass for Organizations subscription.
              </p>
            )}
          </div>
        ) : agreement ? (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryValue label="Tier" value={agreement.tierName} />
              <SummaryValue label="Cadence" value={agreement.cadence} />
              <SummaryValue label="Pass capacity" value={String(agreement.purchasedPassCapacity)} />
              <SummaryValue label="Paid through" value={formatOrgPassDate(agreement.paidUntil)} />
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Badge
                variant={
                  agreement.processingCondition === 'ready' ? 'secondary-outline' : 'destructive'
                }
              >
                Processing: {agreement.processingCondition.replace(/_/g, ' ')}
              </Badge>
              {agreement.providerSubscriptionId ? (
                <span className="text-muted-foreground font-mono text-xs break-all">
                  Subscription: {agreement.providerSubscriptionId}
                </span>
              ) : null}
              {agreement.providerSeatAddOnItemId ? (
                <span className="text-muted-foreground font-mono text-xs break-all">
                  Add-on: {agreement.providerSeatAddOnItemId}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground type-body">
            This organization does not have a Kilo Pass for Organizations subscription.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="type-label text-muted-foreground">{label}</dt>
      <dd className="type-body mt-1 font-medium capitalize tabular-nums">{value}</dd>
    </div>
  );
}
