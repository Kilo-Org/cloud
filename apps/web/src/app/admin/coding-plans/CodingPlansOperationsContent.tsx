'use client';

import Link from 'next/link';
import { useReducer, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { SubscriptionStatusBadge } from '@/components/subscriptions/SubscriptionStatusBadge';
import {
  formatCodingPlanPrice,
  formatDateLabel,
  formatLocalDateTimeLabel,
  getCodingPlanBillingDate,
  getCodingPlanDisplayStatus,
} from '@/components/subscriptions/helpers';
import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { CodingPlanId } from '@/lib/coding-plans/pricing';
import { useTRPC } from '@/lib/trpc/utils';

type OperationsState = {
  providerId: UserByokProviderId;
  planId: CodingPlanId;
  entriesText: string;
  completeInventoryId: string | null;
  replacementInventoryId: string | null;
  replacementApiKey: string;
};

const INITIAL_OPERATIONS_STATE: OperationsState = {
  providerId: 'minimax',
  planId: 'minimax-token-plan-plus',
  entriesText: '',
  completeInventoryId: null,
  replacementInventoryId: null,
  replacementApiKey: '',
};

function updateOperationsState(state: OperationsState, update: Partial<OperationsState>) {
  return { ...state, ...update };
}

export function CodingPlansOperationsContent() {
  const trpc = useTRPC();
  const [state, updateState] = useReducer(updateOperationsState, INITIAL_OPERATIONS_STATE);
  const [insightsRangeDays, setInsightsRangeDays] = useState<InsightsRangeDays>(7);
  const {
    providerId,
    planId,
    entriesText,
    completeInventoryId,
    replacementInventoryId,
    replacementApiKey,
  } = state;
  const setProviderId = (providerId: UserByokProviderId) => updateState({ providerId });
  const setPlanId = (planId: CodingPlanId) => updateState({ planId });
  const setEntriesText = (entriesText: string) => updateState({ entriesText });
  const setCompleteInventoryId = (completeInventoryId: string | null) =>
    updateState({ completeInventoryId });
  const setReplacementInventoryId = (replacementInventoryId: string | null) =>
    updateState({ replacementInventoryId });
  const setReplacementApiKey = (replacementApiKey: string) => updateState({ replacementApiKey });

  const countsQuery = useQuery(trpc.codingPlans.adminKeyInventory.queryOptions({}));
  const queueQuery = useQuery(trpc.codingPlans.adminRevocationQueue.queryOptions({}));
  const subscriptionsQuery = useQuery(trpc.codingPlans.adminListSubscriptions.queryOptions({}));
  const availabilityIntentCountsQuery = useQuery(
    trpc.codingPlans.adminAvailabilityIntentCounts.queryOptions({})
  );
  const catalogQuery = useQuery(trpc.codingPlans.catalog.queryOptions());

  const refreshOperations = async () => {
    await Promise.all([
      countsQuery.refetch(),
      queueQuery.refetch(),
      subscriptionsQuery.refetch(),
      availabilityIntentCountsQuery.refetch(),
    ]);
  };

  const uploadMutation = useMutation(
    trpc.codingPlans.adminUploadKeys.mutationOptions({
      onSuccess: async result => {
        setEntriesText('');
        toast.success(
          `${result.inserted} validated credential${result.inserted === 1 ? '' : 's'} added to inventory.`
        );
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Credential validation or upload failed.'),
    })
  );
  const completeMutation = useMutation(
    trpc.codingPlans.adminMarkRevocationComplete.mutationOptions({
      onSuccess: async () => {
        setCompleteInventoryId(null);
        toast.success('MiniMax credential removed from stock.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to mark credential revoked.'),
    })
  );
  const replacementMutation = useMutation(
    trpc.codingPlans.adminReplaceRevocationCredential.mutationOptions({
      onSuccess: async () => {
        setReplacementInventoryId(null);
        setReplacementApiKey('');
        toast.success('MiniMax credential replaced and returned to stock.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to replace credential.'),
    })
  );
  const submittedEntries = entriesText
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const workItems = queueQuery.data ?? [];
  const inventoryCounts = countsQuery.data ?? [];
  const subscriptions = subscriptionsQuery.data ?? [];
  const availabilityIntentCounts = availabilityIntentCountsQuery.data ?? [];
  const catalog = catalogQuery.data ?? [];
  const providerOptions = Array.from(
    new Map(
      catalog.map(plan => [
        plan.providerId,
        { providerId: plan.providerId, providerName: plan.providerName },
      ])
    ).values()
  );
  const selectedProviderId = providerOptions.some(option => option.providerId === providerId)
    ? providerId
    : (providerOptions[0]?.providerId ?? providerId);
  const planOptions = catalog.filter(plan => plan.providerId === selectedProviderId);
  const selectedPlan = planOptions.find(plan => plan.planId === planId) ?? planOptions[0] ?? null;
  const selectedPlanId = selectedPlan?.planId ?? planId;
  const totalCredentialCount = inventoryCounts.reduce((total, item) => total + item.count, 0);
  const countCredentialsByStatus = (status: string) =>
    inventoryCounts.reduce((total, item) => total + (item.status === status ? item.count : 0), 0);
  const inventorySummary = [
    {
      label: 'Total credentials in system',
      count: totalCredentialCount,
    },
    {
      label: 'Available credentials in system',
      count: countCredentialsByStatus('available'),
    },
    {
      label: 'Assigned credentials',
      count: countCredentialsByStatus('assigned'),
    },
    {
      label: 'Pending revocation credentials',
      count: countCredentialsByStatus('revocation_pending'),
    },
  ];
  const countSubscriptionsByDisplayStatus = (status: string) =>
    subscriptions.reduce(
      (total, subscription) =>
        total + (getCodingPlanDisplayStatus(subscription) === status ? 1 : 0),
      0
    );
  const subscriptionSummary = [
    {
      label: 'Total subscriptions',
      count: subscriptions.length,
    },
    {
      label: 'Active subscriptions',
      count: countSubscriptionsByDisplayStatus('active'),
    },
    {
      label: 'Cancellation pending',
      count: countSubscriptionsByDisplayStatus('pending_cancellation'),
    },
    {
      label: 'Past due subscriptions',
      count: countSubscriptionsByDisplayStatus('past_due'),
    },
  ];
  const insights = getCodingPlanInsights(subscriptions, insightsRangeDays);
  const planPerformanceRows = getPlanPerformanceRows({
    catalog,
    subscriptions,
    inventoryCounts,
    availabilityIntentCounts,
    rangeDays: insightsRangeDays,
  });
  const insightsLoading =
    subscriptionsQuery.isLoading ||
    countsQuery.isLoading ||
    catalogQuery.isLoading ||
    availabilityIntentCountsQuery.isLoading;
  const insightsError =
    subscriptionsQuery.isError ||
    countsQuery.isError ||
    catalogQuery.isError ||
    availabilityIntentCountsQuery.isError;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Coding plans operations</h2>
          <p className="text-muted-foreground max-w-4xl text-sm">
            Track Coding Plan subscriptions, inventory capacity, and manual credential revocation.
          </p>
        </div>
        <Button variant="secondary" asChild>
          <a
            href="https://handbook.kilo.ai/product/runbooks/coding-plans-minimax"
            target="_blank"
            rel="noreferrer"
          >
            View support runbook
            <ExternalLink className="size-4" />
          </a>
        </Button>
      </div>

      <Tabs defaultValue="insights" className="space-y-4">
        <TabsList className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-xl p-1 sm:w-fit sm:flex-row sm:items-center">
          <TabsTrigger value="insights">Insights</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="inventory-management">Inventory management</TabsTrigger>
        </TabsList>

        <TabsContent value="insights" className="mt-0 space-y-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-muted-foreground text-sm">
              Rolling metrics use the selected window. Current-state cards show live totals.
            </p>
            <InsightsRangeFilter value={insightsRangeDays} onChange={setInsightsRangeDays} />
          </div>
          <KpiCards
            items={insights}
            isLoading={subscriptionsQuery.isLoading}
            isError={subscriptionsQuery.isError}
          />
          <PlanPerformanceTable
            rows={planPerformanceRows}
            rangeDays={insightsRangeDays}
            isLoading={insightsLoading}
            isError={insightsError}
          />
        </TabsContent>

        <TabsContent value="subscriptions" className="mt-0 space-y-6">
          <SummaryCards
            items={subscriptionSummary}
            isLoading={subscriptionsQuery.isLoading}
            isError={subscriptionsQuery.isError}
            ariaLabel="Coding Plan subscription summary"
          />

          <SubscriptionsTable
            items={subscriptions}
            isLoading={subscriptionsQuery.isLoading}
            isError={subscriptionsQuery.isError}
          />
        </TabsContent>

        <TabsContent value="inventory-management" className="mt-0">
          <OperationsTabs
            inventorySummary={inventorySummary}
            inventoryCounts={inventoryCounts}
            inventoryLoading={countsQuery.isLoading}
            inventoryError={countsQuery.isError}
            workItems={workItems}
            queueLoading={queueQuery.isLoading}
            queueError={queueQuery.isError}
            providerOptions={providerOptions}
            planOptions={planOptions}
            selectedProviderId={selectedProviderId}
            selectedPlanId={selectedPlanId}
            catalogLoading={catalogQuery.isLoading}
            catalogError={catalogQuery.isError}
            entriesText={entriesText}
            submittedEntries={submittedEntries}
            uploadPending={uploadMutation.isPending}
            onRefresh={() => void refreshOperations()}
            onComplete={setCompleteInventoryId}
            onReplace={setReplacementInventoryId}
            onProviderChange={value => setProviderId(value as UserByokProviderId)}
            onPlanChange={value => setPlanId(value as CodingPlanId)}
            onEntriesTextChange={setEntriesText}
            onUpload={() => {
              if (!selectedPlan) {
                return;
              }

              uploadMutation.mutate({
                providerId: selectedProviderId as UserByokProviderId,
                planId: selectedPlanId as CodingPlanId,
                entries: submittedEntries,
              });
            }}
          />
        </TabsContent>
      </Tabs>

      <OperationsDialogs
        completeInventoryId={completeInventoryId}
        completePending={completeMutation.isPending}
        replacementInventoryId={replacementInventoryId}
        replacementApiKey={replacementApiKey}
        replacementPending={replacementMutation.isPending}
        onCloseComplete={() => setCompleteInventoryId(null)}
        onComplete={inventoryKeyId => completeMutation.mutate({ inventoryKeyId })}
        onCloseReplacement={() => {
          setReplacementInventoryId(null);
          setReplacementApiKey('');
        }}
        onReplacementApiKeyChange={setReplacementApiKey}
        onReplace={(inventoryKeyId, apiKey) =>
          replacementMutation.mutate({ inventoryKeyId, apiKey })
        }
      />
    </div>
  );
}

type SummaryItem = {
  label: string;
  count: number;
};

type KpiItem = {
  label: string;
  value: string;
  detail: string;
};

type InsightsRangeDays = 7 | 14 | 30;

type AdminCodingPlanCatalogItem = {
  planId: string;
  providerName: string;
  name: string;
  providerId: string;
  costKiloCredits: number;
  billingPeriodDays: number;
};

type AvailabilityIntentCountItem = {
  planId: string;
  count: number;
};

type PlanPerformanceRow = {
  planId: string;
  planName: string;
  providerName: string;
  activeSubscriptions: number;
  monthlyRecurringValue: number;
  newSubscriptionsInRange: number;
  canceledSubscriptionsInRange: number;
  availableCredentials: number;
  waitlistIntents: number;
};

type InventoryCountItem = {
  providerId: string;
  planId: string;
  status: string;
  count: number;
};

type InventoryCountRow = {
  providerId: string;
  planId: string;
  loadedCount: number;
  statusCounts: Record<string, number>;
};

type AdminCodingPlanSubscriptionItem = {
  id: string;
  userId: string;
  userName: string;
  planId: string;
  planName: string;
  providerId: string;
  providerName: string;
  status: string;
  billingPeriodDays: number;
  currentPeriodEnd: string;
  creditRenewalAt: string;
  cancelAtPeriodEnd: boolean;
  paymentGraceExpiresAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  costKiloCredits: number;
};

const INVENTORY_STATUS_ORDER = [
  'assigned',
  'available',
  'revocation_pending',
  'revocation_failed',
  'revoked',
];

const INSIGHTS_RANGE_OPTIONS = [7, 14, 30] satisfies InsightsRangeDays[];

type RevocationWorkItem = {
  inventoryKeyId: string;
  providerId: string;
  planId: string;
  upstreamPlanId: string;
  status: string;
  revocationRequestedAt: string | null;
  subscriptionExpiresAt: string | null;
};

function SummaryCards({
  items,
  isLoading,
  isError,
  ariaLabel,
}: {
  items: SummaryItem[];
  isLoading: boolean;
  isError: boolean;
  ariaLabel: string;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={ariaLabel}>
      {items.map(summary => (
        <Card key={summary.label}>
          <CardContent className="space-y-2 p-4">
            <p className="text-muted-foreground text-xs">{summary.label}</p>
            {isLoading ? (
              <Skeleton aria-hidden="true" className="h-8 w-14" />
            ) : isError ? (
              <p className="text-muted-foreground text-sm">Unavailable</p>
            ) : (
              <p className="font-mono text-2xl font-semibold tabular-nums">{summary.count}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function InsightsRangeFilter({
  value,
  onChange,
}: {
  value: InsightsRangeDays;
  onChange: (value: InsightsRangeDays) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-2" aria-label="Insights date range">
      {INSIGHTS_RANGE_OPTIONS.map(option => {
        const selected = option === value;
        return (
          <Button
            key={option}
            type="button"
            variant={selected ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={selected}
            onClick={() => onChange(option)}
          >
            Last {option} days
          </Button>
        );
      })}
    </fieldset>
  );
}

function KpiCards({
  items,
  isLoading,
  isError,
}: {
  items: KpiItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Coding Plan insights">
      {items.map(item => (
        <Card key={item.label}>
          <CardContent className="space-y-3 p-4">
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs">{item.label}</p>
              {isLoading ? (
                <Skeleton aria-hidden="true" className="h-8 w-24" />
              ) : isError ? (
                <p className="text-muted-foreground text-sm">Unavailable</p>
              ) : (
                <p className="font-mono text-2xl font-semibold tabular-nums">{item.value}</p>
              )}
            </div>
            <p className="text-muted-foreground text-xs leading-5">{item.detail}</p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function PlanPerformanceTable({
  rows,
  rangeDays,
  isLoading,
  isError,
}: {
  rows: PlanPerformanceRow[];
  rangeDays: InsightsRangeDays;
  isLoading: boolean;
  isError: boolean;
}) {
  const rangeLabel = formatInsightsRangeLabel(rangeDays);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan performance</CardTitle>
        <CardDescription>
          Subscription movement, recurring value, capacity, and demand by plan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[76rem] table-fixed">
            <colgroup>
              <col className="w-72" />
              <col className="w-36" />
              <col className="w-36" />
              <col className="w-48" />
              <col className="w-48" />
              <col className="w-48" />
              <col className="w-48" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Active subs</TableHead>
                <TableHead className="text-right">MRR</TableHead>
                <TableHead className="text-right">New ({rangeLabel})</TableHead>
                <TableHead className="text-right">Canceled ({rangeLabel})</TableHead>
                <TableHead className="text-right">Available inventory</TableHead>
                <TableHead className="text-right">Waitlist</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-red-300">
                    Unable to load plan performance.
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                    {isLoading ? 'Loading plan performance...' : 'No plan performance data.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(row => (
                  <TableRow key={row.planId}>
                    <TableCell className="min-w-64">
                      <div className="font-medium">{row.planName}</div>
                      <div className="text-muted-foreground mt-1 font-mono text-xs">
                        {row.providerName} / {row.planId}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.activeSubscriptions)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrencyValue(row.monthlyRecurringValue)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.newSubscriptionsInRange)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.canceledSubscriptionsInRange)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.availableCredentials)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.waitlistIntents)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function getCodingPlanInsights(
  subscriptions: AdminCodingPlanSubscriptionItem[],
  rangeDays: InsightsRangeDays
): KpiItem[] {
  const now = new Date();
  const rangeStart = addDays(now, -rangeDays);
  const priorRangeStart = addDays(now, -rangeDays * 2);
  const rangeLabel = `${rangeDays}-day`;
  const rangeDetailLabel = `last ${rangeDays} days`;
  const priorRangeDetailLabel = `prior ${rangeDays} days`;
  const liveSubscriptions = subscriptions.filter(subscription => isLiveSubscription(subscription));
  const pendingCancellationSubscriptions = liveSubscriptions.filter(
    subscription => getCodingPlanDisplayStatus(subscription) === 'pending_cancellation'
  );
  const pastDueSubscriptions = liveSubscriptions.filter(
    subscription => subscription.status === 'past_due'
  );
  const createdInRange = subscriptions.filter(subscription =>
    isTimestampBetween(subscription.createdAt, rangeStart, now)
  );
  const createdInPriorRange = subscriptions.filter(subscription =>
    isTimestampBetween(subscription.createdAt, priorRangeStart, rangeStart)
  );
  const canceledInRange = subscriptions.filter(
    subscription =>
      subscription.status === 'canceled' &&
      subscription.canceledAt !== null &&
      isTimestampBetween(subscription.canceledAt, rangeStart, now)
  );
  const subscriptionsActiveAtPeriodStart = subscriptions.filter(subscription =>
    wasSubscriptionLiveAt(subscription, rangeStart)
  );
  const retainedSubscriptions = subscriptionsActiveAtPeriodStart.filter(
    subscription => subscription.status !== 'canceled'
  );
  const mrr = liveSubscriptions.reduce(
    (total, subscription) => total + getMonthlyKiloCreditValue(subscription),
    0
  );
  const revenueAtRisk = [...pendingCancellationSubscriptions, ...pastDueSubscriptions].reduce(
    (total, subscription) => total + getMonthlyKiloCreditValue(subscription),
    0
  );
  const periodGrowthRate = calculateRate(
    createdInRange.length - canceledInRange.length,
    createdInPriorRange.length
  );
  const retentionRate = calculateRate(
    retainedSubscriptions.length,
    subscriptionsActiveAtPeriodStart.length
  );
  const churnRate = calculateRate(canceledInRange.length, subscriptionsActiveAtPeriodStart.length);

  return [
    {
      label: 'Active MRR',
      value: formatCurrencyValue(mrr),
      detail: `${liveSubscriptions.length} live subscription${liveSubscriptions.length === 1 ? '' : 's'}`,
    },
    {
      label: `${rangeLabel} growth`,
      value: formatPercentValue(periodGrowthRate),
      detail: `${formatSignedCount(createdInRange.length - canceledInRange.length)} net in ${rangeDetailLabel}`,
    },
    {
      label: `${rangeLabel} retention`,
      value: formatPercentValue(retentionRate),
      detail: `${retainedSubscriptions.length}/${subscriptionsActiveAtPeriodStart.length} retained from ${rangeDays} days ago`,
    },
    {
      label: `${rangeLabel} churn`,
      value: formatPercentValue(churnRate),
      detail: `${canceledInRange.length} canceled in ${rangeDetailLabel}`,
    },
    {
      label: 'Revenue at risk',
      value: formatCurrencyValue(revenueAtRisk),
      detail: `${pendingCancellationSubscriptions.length} canceling, ${pastDueSubscriptions.length} past due`,
    },
    {
      label: 'New subscriptions',
      value: formatIntegerValue(createdInRange.length),
      detail: `${createdInPriorRange.length} created in ${priorRangeDetailLabel}`,
    },
    {
      label: 'Cancellation pending',
      value: formatPercentValue(
        calculateRate(pendingCancellationSubscriptions.length, liveSubscriptions.length)
      ),
      detail: `${pendingCancellationSubscriptions.length}/${liveSubscriptions.length} live subscriptions`,
    },
    {
      label: 'Past due exposure',
      value: formatCurrencyValue(
        pastDueSubscriptions.reduce(
          (total, subscription) => total + getMonthlyKiloCreditValue(subscription),
          0
        )
      ),
      detail: `${pastDueSubscriptions.length} subscription${pastDueSubscriptions.length === 1 ? '' : 's'} in recovery`,
    },
  ];
}

function getPlanPerformanceRows({
  catalog,
  subscriptions,
  inventoryCounts,
  availabilityIntentCounts,
  rangeDays,
}: {
  catalog: AdminCodingPlanCatalogItem[];
  subscriptions: AdminCodingPlanSubscriptionItem[];
  inventoryCounts: InventoryCountItem[];
  availabilityIntentCounts: AvailabilityIntentCountItem[];
  rangeDays: InsightsRangeDays;
}): PlanPerformanceRow[] {
  const now = new Date();
  const rangeStart = addDays(now, -rangeDays);

  return catalog.map(plan => {
    const planSubscriptions = subscriptions.filter(
      subscription => subscription.planId === plan.planId
    );
    const liveSubscriptions = planSubscriptions.filter(subscription =>
      isLiveSubscription(subscription)
    );
    const newSubscriptionsInRange = planSubscriptions.filter(subscription =>
      isTimestampBetween(subscription.createdAt, rangeStart, now)
    ).length;
    const canceledSubscriptionsInRange = planSubscriptions.filter(
      subscription =>
        subscription.status === 'canceled' &&
        subscription.canceledAt !== null &&
        isTimestampBetween(subscription.canceledAt, rangeStart, now)
    ).length;
    const availableCredentials = inventoryCounts
      .filter(item => item.planId === plan.planId && item.status === 'available')
      .reduce((total, item) => total + item.count, 0);
    const waitlistIntents =
      availabilityIntentCounts.find(item => item.planId === plan.planId)?.count ?? 0;
    const monthlyRecurringValue = liveSubscriptions.reduce(
      (total, subscription) => total + getMonthlyKiloCreditValue(subscription),
      0
    );

    return {
      planId: plan.planId,
      planName: plan.name,
      providerName: plan.providerName,
      activeSubscriptions: liveSubscriptions.length,
      monthlyRecurringValue,
      newSubscriptionsInRange,
      canceledSubscriptionsInRange,
      availableCredentials,
      waitlistIntents,
    };
  });
}

function InventoryCountsTable({
  items,
  isLoading,
  isError,
}: {
  items: InventoryCountItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  const statusColumns = getInventoryStatusColumns(items);
  const rows = getInventoryCountRows(items);
  const columnCount = 3 + statusColumns.length;
  const metricColumnKeys = ['loaded', ...statusColumns];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventory counts</CardTitle>
        <CardDescription>Credential inventory grouped by provider and plan.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[72rem] table-fixed">
            <colgroup>
              <col className="w-32" />
              <col className="w-80" />
              {metricColumnKeys.map(key => (
                <col key={key} />
              ))}
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-center">Loaded</TableHead>
                {statusColumns.map(status => (
                  <TableHead key={status} className="text-center">
                    {formatStatusTitle(status)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={columnCount} className="h-24 text-center text-red-300">
                    Unable to load inventory counts.
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columnCount}
                    className="text-muted-foreground h-24 text-center"
                  >
                    {isLoading ? 'Loading inventory counts...' : 'No inventory recorded.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(row => (
                  <TableRow key={`${row.providerId}:${row.planId}`}>
                    <TableCell className="min-w-32 font-mono text-xs">{row.providerId}</TableCell>
                    <TableCell className="min-w-64 font-mono text-xs">{row.planId}</TableCell>
                    <TableCell className="text-center font-mono tabular-nums">
                      {row.loadedCount}
                    </TableCell>
                    {statusColumns.map(status => (
                      <TableCell key={status} className="text-center font-mono tabular-nums">
                        {row.statusCounts[status] ?? 0}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function getInventoryStatusColumns(items: InventoryCountItem[]) {
  const statuses = new Set(items.map(item => item.status));
  const knownStatuses = INVENTORY_STATUS_ORDER.filter(status => statuses.has(status));
  const unknownStatuses = Array.from(statuses)
    .filter(status => !INVENTORY_STATUS_ORDER.includes(status))
    .sort();

  return [...knownStatuses, ...unknownStatuses];
}

function getInventoryCountRows(items: InventoryCountItem[]): InventoryCountRow[] {
  const rowsByKey = new Map<string, InventoryCountRow>();

  for (const item of items) {
    const rowKey = `${item.providerId}\u0000${item.planId}`;
    const existingRow = rowsByKey.get(rowKey);
    const row = existingRow ?? {
      providerId: item.providerId,
      planId: item.planId,
      loadedCount: 0,
      statusCounts: {},
    };

    row.loadedCount += item.count;
    row.statusCounts[item.status] = (row.statusCounts[item.status] ?? 0) + item.count;
    rowsByKey.set(rowKey, row);
  }

  return Array.from(rowsByKey.values()).sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) || left.planId.localeCompare(right.planId)
  );
}

function isLiveSubscription(subscription: AdminCodingPlanSubscriptionItem): boolean {
  return subscription.status === 'active' || subscription.status === 'past_due';
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isTimestampBetween(value: string, start: Date, end: Date): boolean {
  const timestamp = new Date(value).getTime();
  return timestamp >= start.getTime() && timestamp < end.getTime();
}

function wasSubscriptionLiveAt(subscription: AdminCodingPlanSubscriptionItem, date: Date): boolean {
  const createdAt = new Date(subscription.createdAt).getTime();
  const canceledAt = subscription.canceledAt ? new Date(subscription.canceledAt).getTime() : null;
  const target = date.getTime();

  return createdAt < target && (canceledAt === null || canceledAt >= target);
}

function getMonthlyKiloCreditValue(subscription: AdminCodingPlanSubscriptionItem): number {
  return subscription.costKiloCredits * (30 / subscription.billingPeriodDays);
}

function calculateRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function formatCurrencyValue(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatPercentValue(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return value.toLocaleString('en-US', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

function formatIntegerValue(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSignedCount(value: number): string {
  return value > 0 ? `+${formatIntegerValue(value)}` : formatIntegerValue(value);
}

function formatInsightsRangeLabel(rangeDays: InsightsRangeDays): string {
  return `last ${rangeDays} days`;
}

function SubscriptionsTable({
  items,
  isLoading,
  isError,
}: {
  items: AdminCodingPlanSubscriptionItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscriptions</CardTitle>
        <CardDescription>Coding Plan subscriptions and billing state.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Provider / plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Billing date</TableHead>
                <TableHead className="text-right">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-red-300">
                    Unable to load subscriptions.
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                    {isLoading ? 'Loading subscriptions...' : 'No subscriptions recorded.'}
                  </TableCell>
                </TableRow>
              ) : (
                items.map(item => {
                  const displayStatus = getCodingPlanDisplayStatus(item);
                  const billingDate = getCodingPlanBillingDate(item);
                  const formattedBillingDate =
                    item.status === 'past_due'
                      ? formatLocalDateTimeLabel(billingDate.date)
                      : formatDateLabel(billingDate.date);

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-56 font-mono text-xs">
                        <Link
                          href={`/admin/users/${encodeURIComponent(item.userId)}`}
                          className="text-link hover:text-link-hover underline-offset-4 hover:underline"
                        >
                          {item.userName}
                        </Link>
                      </TableCell>
                      <TableCell className="min-w-56 font-mono text-xs">
                        <div className="flex items-center gap-2">
                          <span>{item.id}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Copy subscription ${item.id}`}
                            onClick={() => void copySubscriptionId(item.id)}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="min-w-56 font-mono text-xs">
                        <div>{item.providerName}</div>
                        <div className="text-muted-foreground mt-1">{item.planName}</div>
                      </TableCell>
                      <TableCell>
                        <SubscriptionStatusBadge status={displayStatus} />
                      </TableCell>
                      <TableCell className="min-w-40">
                        <div className="text-muted-foreground text-xs">{billingDate.label}</div>
                        <div className="font-mono text-xs tabular-nums">{formattedBillingDate}</div>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCodingPlanPrice(
                          item.costKiloCredits,
                          item.billingPeriodDays,
                          item.planId
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

async function copySubscriptionId(subscriptionId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(subscriptionId);
    toast.success('Subscription ID copied');
  } catch {
    toast.error('Failed to copy subscription ID');
  }
}

function OperationsTabs({
  inventorySummary,
  inventoryCounts,
  inventoryLoading,
  inventoryError,
  workItems,
  queueLoading,
  queueError,
  providerOptions,
  planOptions,
  selectedProviderId,
  selectedPlanId,
  catalogLoading,
  catalogError,
  entriesText,
  submittedEntries,
  uploadPending,
  onRefresh,
  onComplete,
  onReplace,
  onProviderChange,
  onPlanChange,
  onEntriesTextChange,
  onUpload,
}: {
  inventorySummary: SummaryItem[];
  inventoryCounts: InventoryCountItem[];
  inventoryLoading: boolean;
  inventoryError: boolean;
  workItems: RevocationWorkItem[];
  queueLoading: boolean;
  queueError: boolean;
  providerOptions: { providerId: string; providerName: string }[];
  planOptions: { planId: string; name: string }[];
  selectedProviderId: string;
  selectedPlanId: string;
  catalogLoading: boolean;
  catalogError: boolean;
  entriesText: string;
  submittedEntries: string[];
  uploadPending: boolean;
  onRefresh: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onReplace: (inventoryKeyId: string) => void;
  onProviderChange: (providerId: string) => void;
  onPlanChange: (planId: string) => void;
  onEntriesTextChange: (entriesText: string) => void;
  onUpload: () => void;
}) {
  const hasSelectedPlan = planOptions.some(plan => plan.planId === selectedPlanId);

  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-xl p-1 sm:w-fit sm:flex-row sm:items-center">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="revocation-queue">Pending Key Rotation</TabsTrigger>
        <TabsTrigger value="inventory-upload">Upload validated inventory</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="mt-0 space-y-6">
        <SummaryCards
          items={inventorySummary}
          isLoading={inventoryLoading}
          isError={inventoryError}
          ariaLabel="Credential inventory summary"
        />

        <InventoryCountsTable
          items={inventoryCounts}
          isLoading={inventoryLoading}
          isError={inventoryError}
        />
      </TabsContent>

      <TabsContent value="revocation-queue" className="mt-0">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Pending Key Rotation</CardTitle>
              <CardDescription>
                Pending and failed issued credentials requiring MiniMax admin action. Revoke removes
                stock permanently; Replace validates a newly generated key for the same plan ID.
              </CardDescription>
            </div>
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Inventory item</TableHead>
                    <TableHead>Provider / plan</TableHead>
                    <TableHead>Upstream plan ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Subscription expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueError ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-red-300">
                        Unable to load manual revocation work. Refresh to retry.
                      </TableCell>
                    </TableRow>
                  ) : workItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                        {queueLoading ? 'Loading manual work...' : 'No revocation work pending.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    workItems.map(item => (
                      <TableRow key={item.inventoryKeyId}>
                        <TableCell className="min-w-56 font-mono text-xs">
                          {item.inventoryKeyId}
                        </TableCell>
                        <TableCell className="min-w-56 font-mono text-xs">
                          <div>{item.providerId}</div>
                          <div className="text-muted-foreground mt-1">{item.planId}</div>
                        </TableCell>
                        <TableCell className="min-w-44 font-mono text-xs">
                          {item.upstreamPlanId}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={
                              item.status === 'revocation_failed'
                                ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/20'
                                : 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20'
                            }
                          >
                            {formatStatus(item.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {formatTimestamp(item.revocationRequestedAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {formatTimestamp(item.subscriptionExpiresAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => onComplete(item.inventoryKeyId)}
                            >
                              Revoke
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onReplace(item.inventoryKeyId)}
                            >
                              Replace
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="inventory-upload" className="mt-0">
        <Card>
          <CardHeader>
            <CardTitle>Upload validated inventory</CardTitle>
            <CardDescription>
              Choose the BYOK provider ID and Kilo plan for this batch. Enter one API key and
              upstream plan ID pair per line.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {catalogError ? (
              <Alert variant="warning">
                <AlertDescription>
                  Unable to load the Coding Plan catalog. Refresh before uploading inventory.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="coding-plan-provider">Provider</Label>
                <Select
                  value={selectedProviderId}
                  onValueChange={onProviderChange}
                  disabled={catalogLoading || providerOptions.length === 0 || uploadPending}
                >
                  <SelectTrigger id="coding-plan-provider">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map(provider => (
                      <SelectItem key={provider.providerId} value={provider.providerId}>
                        {provider.providerId} ({provider.providerName})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="coding-plan-plan">Plan</Label>
                <Select
                  value={selectedPlanId}
                  onValueChange={onPlanChange}
                  disabled={catalogLoading || planOptions.length === 0 || uploadPending}
                >
                  <SelectTrigger id="coding-plan-plan">
                    <SelectValue placeholder="Select plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {planOptions.map(plan => (
                      <SelectItem key={plan.planId} value={plan.planId}>
                        {plan.name} ({plan.planId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="coding-plan-entries">API keys and upstream plan IDs</Label>
              <Textarea
                id="coding-plan-entries"
                value={entriesText}
                onChange={event => onEntriesTextChange(event.target.value)}
                placeholder="<api key>::<upstream plan id>"
                className="min-h-28 font-mono"
                autoComplete="off"
              />
            </div>
            <Alert>
              <ShieldAlert className="size-4" />
              <AlertDescription>
                API keys are encrypted after validation and never returned. MiniMax plan IDs are
                stored for deprovisioning and shown in the manual revocation queue.
              </AlertDescription>
            </Alert>
            <Button
              onClick={onUpload}
              disabled={!hasSelectedPlan || submittedEntries.length === 0 || uploadPending}
              aria-busy={uploadPending}
            >
              <Upload className="size-4" />
              {uploadPending ? 'Validating credentials...' : 'Validate and add inventory'}
            </Button>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function OperationsDialogs({
  completeInventoryId,
  completePending,
  replacementInventoryId,
  replacementApiKey,
  replacementPending,
  onCloseComplete,
  onComplete,
  onCloseReplacement,
  onReplacementApiKeyChange,
  onReplace,
}: {
  completeInventoryId: string | null;
  completePending: boolean;
  replacementInventoryId: string | null;
  replacementApiKey: string;
  replacementPending: boolean;
  onCloseComplete: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onCloseReplacement: () => void;
  onReplacementApiKeyChange: (apiKey: string) => void;
  onReplace: (inventoryKeyId: string, apiKey: string) => void;
}) {
  return (
    <>
      <Dialog open={completeInventoryId !== null} onOpenChange={open => !open && onCloseComplete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke credential?</DialogTitle>
            <DialogDescription>
              Use this only when MiniMax access should be completely removed from stock. Kilo
              records the plan ID as revoked and keeps this credential unavailable for reuse.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseComplete}>
              Keep pending
            </Button>
            <Button
              variant="destructive"
              onClick={() => completeInventoryId && onComplete(completeInventoryId)}
              disabled={completePending}
            >
              {completePending ? 'Revoking...' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={replacementInventoryId !== null}
        onOpenChange={open => !open && onCloseReplacement()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace MiniMax API key</DialogTitle>
            <DialogDescription>
              Paste the newly generated MiniMax API key for this same upstream plan ID. Kilo
              validates the key before returning this plan to available inventory.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="replacement-api-key">Replacement API key</Label>
            <Input
              id="replacement-api-key"
              type="password"
              value={replacementApiKey}
              onChange={event => onReplacementApiKeyChange(event.target.value)}
              autoComplete="off"
              placeholder="Paste new MiniMax API key"
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseReplacement}>
              Keep pending
            </Button>
            <Button
              onClick={() =>
                replacementInventoryId && onReplace(replacementInventoryId, replacementApiKey)
              }
              disabled={replacementApiKey.trim().length === 0 || replacementPending}
            >
              {replacementPending ? 'Validating...' : 'Validate and replace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatStatus(status: string): string {
  return status.replaceAll('_', ' ');
}

function formatStatusTitle(status: string): string {
  return formatStatus(status).replace(/\b\w/g, character => character.toUpperCase());
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}
