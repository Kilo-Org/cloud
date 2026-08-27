'use client';

import { AlertCircle, BellRing, ChevronRight, Info, Loader2, Plus, RefreshCw } from 'lucide-react';
import { LowBalanceAlertCard } from '@/components/organizations/alerts/LowBalanceAlertCard';
import {
  ORGANIZATION_ALERT_STATUS_PRESENTATION,
  organizationAlertSummary,
} from '@/components/organizations/alerts/alert-presentation';
import {
  OrganizationAlertsDrawerStackProvider,
  useOrganizationAlertsDrawerStack,
} from '@/components/organizations/alerts/drawer/OrganizationAlertsDrawerStack';
import { organizationAlertDefinition } from '@/components/organizations/alerts/registry.client';
import { useOrganizationAlertsQuery } from '@/components/organizations/alerts/useOrganizationAlerts';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type OrganizationAlertsPageProps = {
  organizationId: string;
  /** Monthly spending alerts can only be created by Enterprise organizations. */
  isEnterprise: boolean;
};

/**
 * The general organization Alerts surface. Reaching this page requires the same
 * billing authority the alerts router enforces, which is why recipient counts
 * and thresholds can be shown here at all; the server, not this component, is
 * what keeps them from ordinary members.
 *
 * The list stays mounted while the create and edit drawers are open, and the
 * drawer reads the same cached pages this list renders.
 */
function OrganizationAlertsPageContent({
  organizationId,
  isEnterprise,
}: OrganizationAlertsPageProps) {
  const drawer = useOrganizationAlertsDrawerStack();

  // The alert collection has no product count limit, so it is only ever read in
  // bounded cursor pages.
  const alertsQuery = useOrganizationAlertsQuery(organizationId);

  const alerts = alertsQuery.data?.pages.flatMap(page => page.alerts);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <OrganizationPageHeader organizationId={organizationId} title="Alerts" />
          <p className="type-body text-muted-foreground">
            Email the people accountable for cost when this organization&apos;s AI usage spend or
            available balance crosses an amount you choose.
          </p>
        </div>
        <Button
          disabled={!isEnterprise}
          title={
            isEnterprise ? undefined : 'Monthly spending alerts require an Enterprise organization.'
          }
          onClick={() => drawer.open({ type: 'alert-create' })}
        >
          <Plus className="size-4" />
          New alert
        </Button>
      </div>

      <Alert>
        <Info />
        <AlertTitle>Alerts are informational</AlertTitle>
        <AlertDescription>
          <p>
            Kilo emails the recipients on each alert. Alerts never interrupt usage or cap charges,
            and measured amounts may lag recent usage.
          </p>
        </AlertDescription>
      </Alert>

      {!isEnterprise && (
        <Alert>
          <Info />
          <AlertTitle>Monthly spending alerts need Enterprise</AlertTitle>
          <AlertDescription>
            <p>
              This organization is not on the Enterprise plan, so new monthly spending alerts cannot
              be created and existing ones are not evaluated. Alerts already here stay visible and
              can still be disabled, archived, or have recipients removed.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Spending alerts</CardTitle>
          <CardDescription>
            Each alert has its own threshold, recipients, and enabled state. Archived alerts are
            hidden.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {alertsQuery.isPending ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-3">
              <span className="sr-only">Loading alerts...</span>
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : alertsQuery.isError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Alerts could not be loaded</AlertTitle>
              <AlertDescription>
                <p>{alertsQuery.error.message}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void alertsQuery.refetch()}
                  disabled={alertsQuery.isRefetching}
                >
                  {alertsQuery.isRefetching ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Retrying...
                    </>
                  ) : (
                    <>
                      <RefreshCw />
                      Retry
                    </>
                  )}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !alerts || alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <BellRing className="size-8 text-muted-foreground" />
              <div>
                <p className="type-heading">No alerts yet</p>
                <p className="type-body text-muted-foreground">
                  Create an alert to notify people when this organization&apos;s AI usage spend
                  reaches an amount you choose.
                </p>
              </div>
            </div>
          ) : (
            <ul className="divide-border divide-y">
              {alerts.map(alert => {
                const status = ORGANIZATION_ALERT_STATUS_PRESENTATION[alert.status];
                const definition = organizationAlertDefinition(alert.type);
                return (
                  <li key={alert.id}>
                    <button
                      className="flex w-full cursor-pointer items-center gap-3 py-3 text-left hover:bg-surface-hover"
                      onClick={() => drawer.open({ type: 'alert-edit', alertId: alert.id })}
                    >
                      <definition.Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="type-body font-medium">{definition.label}</span>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </span>
                        <span className="type-label text-muted-foreground">
                          {organizationAlertSummary(alert)}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {alertsQuery.hasNextPage && (
            <Button
              className="self-start"
              variant="outline"
              size="sm"
              onClick={() => void alertsQuery.fetchNextPage()}
              disabled={alertsQuery.isFetchingNextPage}
            >
              {alertsQuery.isFetchingNextPage ? (
                <>
                  <Loader2 className="animate-spin" />
                  Loading more alerts...
                </>
              ) : (
                'Load more alerts'
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <LowBalanceAlertCard organizationId={organizationId} />
    </div>
  );
}

export function OrganizationAlertsPage(props: OrganizationAlertsPageProps) {
  return (
    <OrganizationAlertsDrawerStackProvider
      organizationId={props.organizationId}
      // Enterprise is the client-visible half of the entitlement; the router also
      // requires the same subscription or trial other billing mutations require,
      // and reports that as an inline error in the editor.
      canExpand={props.isEnterprise}
    >
      <OrganizationAlertsPageContent {...props} />
    </OrganizationAlertsDrawerStackProvider>
  );
}
