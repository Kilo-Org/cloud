'use client';

import Link from 'next/link';
import { useEffect, useReducer, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw, Search, ShieldAlert, Upload, X } from 'lucide-react';
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
  canSubmitExtensionDays,
  getCancelSubscriptionDialogCopy,
  getCodingPlanInsights,
  getCodingPlanProviderDisplayName,
  getExtendSubscriptionDialogCopy,
  getInventoryReplacementCompleteToast,
  getInventoryReplacementDialogCopy,
  getPlanPerformanceRows,
  getReplacementCompleteToast,
  getReplacementDialogCopy,
  getRevocationCompleteToast,
  getRevocationDialogCopy,
  getSubscriptionSummaryItems,
  type InsightsRangeDays,
} from '@/app/admin/coding-plans/coding-plan-operations';
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

type SubscriptionDisplayStatus = 'active' | 'pending_cancellation' | 'past_due' | 'canceled';

type OperationsState = {
  providerId: UserByokProviderId;
  planId: CodingPlanId;
  entriesText: string;
  completeSelection: RevocationSelection | null;
  replacementSelection: RevocationSelection | null;
  replacementApiKey: string;
  inventoryReplacementId: string;
  inventoryReplacementApiKey: string;
  inventoryReplacementConfirmOpen: boolean;
  cancelSelection: AdminCodingPlanSubscriptionItem | null;
  extendSelection: AdminCodingPlanSubscriptionItem | null;
  extendDays: string;
};

const EMPTY_SUBSCRIPTION_SUMMARY = {
  total: 0,
  active: 0,
  pendingCancellation: 0,
  pastDue: 0,
};

const EMPTY_INSIGHT_TOTALS = {
  liveSubscriptions: 0,
  pendingCancellation: 0,
  pastDue: 0,
  mrrKiloCredits: 0,
  revenueAtRiskKiloCredits: 0,
  pastDueMrrKiloCredits: 0,
  createdInRange: 0,
  createdInPriorRange: 0,
  canceledInRange: 0,
  liveAtRangeStart: 0,
  retainedFromRangeStart: 0,
  currentWaitersJoinedInRange: 0,
  currentWaitersJoinedInPriorRange: 0,
  currentWaitlistTotal: 0,
};

const INITIAL_OPERATIONS_STATE: OperationsState = {
  providerId: 'minimax',
  planId: 'minimax-token-plan-plus',
  entriesText: '',
  completeSelection: null,
  replacementSelection: null,
  replacementApiKey: '',
  inventoryReplacementId: '',
  inventoryReplacementApiKey: '',
  inventoryReplacementConfirmOpen: false,
  cancelSelection: null,
  extendSelection: null,
  extendDays: '7',
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
    completeSelection,
    replacementSelection,
    replacementApiKey,
    inventoryReplacementId,
    inventoryReplacementApiKey,
    inventoryReplacementConfirmOpen,
    cancelSelection,
    extendSelection,
    extendDays,
  } = state;
  const [subscriptionPage, setSubscriptionPage] = useState(1);
  const [subscriptionSearchDraft, setSubscriptionSearchDraft] = useState('');
  const [subscriptionSearch, setSubscriptionSearch] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionDisplayStatus | 'all'>(
    'all'
  );
  const setProviderId = (providerId: UserByokProviderId) => updateState({ providerId });
  const setPlanId = (planId: CodingPlanId) => updateState({ planId });
  const setEntriesText = (entriesText: string) => updateState({ entriesText });
  const setCompleteSelection = (completeSelection: RevocationSelection | null) =>
    updateState({ completeSelection });
  const setReplacementSelection = (replacementSelection: RevocationSelection | null) =>
    updateState({ replacementSelection });
  const setReplacementApiKey = (replacementApiKey: string) => updateState({ replacementApiKey });
  const setInventoryReplacementId = (inventoryReplacementId: string) =>
    updateState({ inventoryReplacementId });
  const setInventoryReplacementApiKey = (inventoryReplacementApiKey: string) =>
    updateState({ inventoryReplacementApiKey });
  const setInventoryReplacementConfirmOpen = (inventoryReplacementConfirmOpen: boolean) =>
    updateState({ inventoryReplacementConfirmOpen });
  const setCancelSelection = (cancelSelection: AdminCodingPlanSubscriptionItem | null) =>
    updateState({ cancelSelection });
  const setExtendSelection = (extendSelection: AdminCodingPlanSubscriptionItem | null) =>
    updateState({ extendSelection });
  const setExtendDays = (extendDays: string) => updateState({ extendDays });

  const countsQuery = useQuery(trpc.codingPlans.adminKeyInventory.queryOptions({}));
  const queueQuery = useQuery(trpc.codingPlans.adminRevocationQueue.queryOptions({}));
  const subscriptionsQuery = useQuery({
    ...trpc.codingPlans.adminListSubscriptions.queryOptions({
      page: subscriptionPage,
      search: subscriptionSearch || undefined,
      status: subscriptionStatus === 'all' ? undefined : subscriptionStatus,
    }),
    placeholderData: keepPreviousData,
  });
  const subscriptionOverviewQuery = useQuery(
    trpc.codingPlans.adminSubscriptionOverview.queryOptions()
  );
  const insightsQuery = useQuery(
    trpc.codingPlans.adminInsights.queryOptions({ rangeDays: insightsRangeDays })
  );
  const catalogQuery = useQuery(trpc.codingPlans.catalog.queryOptions());

  const refreshOperations = async () => {
    await Promise.all([
      countsQuery.refetch(),
      queueQuery.refetch(),
      subscriptionsQuery.refetch(),
      subscriptionOverviewQuery.refetch(),
      insightsQuery.refetch(),
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
        const providerDisplayName = completeSelection?.providerDisplayName ?? null;
        setCompleteSelection(null);
        toast.success(getRevocationCompleteToast(providerDisplayName));
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to mark credential revoked.'),
    })
  );
  const replacementMutation = useMutation(
    trpc.codingPlans.adminReplaceRevocationCredential.mutationOptions({
      onSuccess: async () => {
        const providerDisplayName = replacementSelection?.providerDisplayName ?? null;
        setReplacementSelection(null);
        setReplacementApiKey('');
        toast.success(getReplacementCompleteToast(providerDisplayName));
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to replace credential.'),
    })
  );
  const inventoryReplacementMutation = useMutation(
    trpc.codingPlans.adminReplaceInventoryCredential.mutationOptions({
      onSuccess: async () => {
        setInventoryReplacementId('');
        setInventoryReplacementApiKey('');
        setInventoryReplacementConfirmOpen(false);
        toast.success(getInventoryReplacementCompleteToast());
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to replace inventory credential.'),
    })
  );
  const cancelMutation = useMutation(
    trpc.codingPlans.adminCancelSubscription.mutationOptions({
      onSuccess: async () => {
        setCancelSelection(null);
        toast.success('Subscription cancellation scheduled at period end.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to cancel subscription.'),
    })
  );
  const extendMutation = useMutation(
    trpc.codingPlans.adminExtendSubscriptionPeriod.mutationOptions({
      onSuccess: async result => {
        setExtendSelection(null);
        setExtendDays('7');
        toast.success(
          `Current period extended to ${formatDateLabel(result.currentPeriodEnd)}. Renewal now ${formatDateLabel(result.creditRenewalAt)}.`
        );
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to extend subscription.'),
    })
  );
  const submittedEntries = entriesText
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const canSubmitExtend = canSubmitExtensionDays(extendDays);

  useEffect(() => {
    const normalizedPage = subscriptionsQuery.data?.pagination.page;
    if (
      normalizedPage === undefined ||
      normalizedPage === subscriptionPage ||
      subscriptionsQuery.isFetching ||
      subscriptionsQuery.isPlaceholderData
    ) {
      return;
    }
    setSubscriptionPage(normalizedPage);
  }, [
    subscriptionPage,
    subscriptionsQuery.data?.pagination.page,
    subscriptionsQuery.isFetching,
    subscriptionsQuery.isPlaceholderData,
  ]);
  const workItems = queueQuery.data ?? [];
  const inventoryCounts = countsQuery.data ?? [];
  const subscriptions = subscriptionsQuery.data?.items ?? [];
  const subscriptionPagination = subscriptionsQuery.data?.pagination;
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
  const subscriptionSummary = getSubscriptionSummaryItems(
    subscriptionOverviewQuery.data ?? EMPTY_SUBSCRIPTION_SUMMARY
  );
  const insights = getCodingPlanInsights(
    insightsQuery.data?.totals ?? EMPTY_INSIGHT_TOTALS,
    insightsRangeDays
  );
  const planPerformanceRows = getPlanPerformanceRows({
    catalog: catalog.map(plan => ({
      planId: plan.planId,
      planName: plan.name,
      providerName: plan.providerName,
    })),
    inventoryCounts,
    planInsights: insightsQuery.data?.plans ?? [],
  });
  const insightsLoading =
    insightsQuery.isLoading || countsQuery.isLoading || catalogQuery.isLoading;
  const insightsError = insightsQuery.isError || countsQuery.isError || catalogQuery.isError;

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
            MiniMax support runbook
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
              Waitlist movement uses join dates for users still waiting; resolved intents are
              removed.
            </p>
            <InsightsRangeFilter value={insightsRangeDays} onChange={setInsightsRangeDays} />
          </div>
          <KpiCards
            items={insights}
            isLoading={insightsQuery.isLoading}
            isError={insightsQuery.isError}
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
            isLoading={subscriptionOverviewQuery.isLoading}
            isError={subscriptionOverviewQuery.isError}
            ariaLabel="Coding Plan subscription summary"
          />

          <SubscriptionsTable
            items={subscriptions}
            pagination={subscriptionPagination}
            isLoading={subscriptionsQuery.isLoading}
            isFetching={subscriptionsQuery.isFetching}
            isError={subscriptionsQuery.isError}
            searchDraft={subscriptionSearchDraft}
            search={subscriptionSearch}
            status={subscriptionStatus}
            onSearchDraftChange={setSubscriptionSearchDraft}
            onSearch={nextSearch => {
              setSubscriptionSearch(nextSearch);
              setSubscriptionPage(1);
            }}
            onStatusChange={status => {
              setSubscriptionStatus(status);
              setSubscriptionPage(1);
            }}
            onPageChange={setSubscriptionPage}
            onCancel={setCancelSelection}
            onExtend={item => {
              setExtendSelection(item);
              setExtendDays('7');
            }}
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
            onComplete={workItem =>
              setCompleteSelection({
                workItem,
                providerDisplayName: getCodingPlanProviderDisplayName(
                  providerOptions,
                  workItem.providerId
                ),
              })
            }
            onReplace={workItem =>
              setReplacementSelection({
                workItem,
                providerDisplayName: getCodingPlanProviderDisplayName(
                  providerOptions,
                  workItem.providerId
                ),
              })
            }
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
            inventoryReplacementId={inventoryReplacementId}
            inventoryReplacementApiKey={inventoryReplacementApiKey}
            onInventoryReplacementIdChange={setInventoryReplacementId}
            onInventoryReplacementApiKeyChange={setInventoryReplacementApiKey}
            onConfirmInventoryReplacement={() => {
              if (
                inventoryReplacementId.trim().length === 0 ||
                inventoryReplacementApiKey.trim().length === 0
              ) {
                return;
              }
              setInventoryReplacementConfirmOpen(true);
            }}
          />
        </TabsContent>
      </Tabs>

      <OperationsDialogs
        completeSelection={completeSelection}
        completePending={completeMutation.isPending}
        replacementSelection={replacementSelection}
        replacementApiKey={replacementApiKey}
        replacementPending={replacementMutation.isPending}
        onCloseComplete={() => setCompleteSelection(null)}
        onComplete={inventoryKeyId => completeMutation.mutate({ inventoryKeyId })}
        onCloseReplacement={() => {
          setReplacementSelection(null);
          setReplacementApiKey('');
        }}
        onReplacementApiKeyChange={setReplacementApiKey}
        onReplace={(inventoryKeyId, apiKey) =>
          replacementMutation.mutate({ inventoryKeyId, apiKey })
        }
        cancelSelection={cancelSelection}
        cancelPending={cancelMutation.isPending}
        onCloseCancel={() => setCancelSelection(null)}
        onCancel={subscriptionId => cancelMutation.mutate({ subscriptionId })}
        extendSelection={extendSelection}
        extendDays={extendDays}
        extendPending={extendMutation.isPending}
        canSubmitExtend={canSubmitExtend}
        onCloseExtend={() => {
          setExtendSelection(null);
          setExtendDays('7');
        }}
        onExtendDaysChange={setExtendDays}
        onExtend={(subscriptionId, days) => extendMutation.mutate({ subscriptionId, days })}
        inventoryReplacementId={inventoryReplacementId}
        inventoryReplacementConfirmOpen={inventoryReplacementConfirmOpen}
        inventoryReplacementPending={inventoryReplacementMutation.isPending}
        onCloseInventoryReplacement={() => setInventoryReplacementConfirmOpen(false)}
        onReplaceInventoryCredential={() => {
          if (
            inventoryReplacementId.trim().length === 0 ||
            inventoryReplacementApiKey.trim().length === 0
          ) {
            return;
          }
          inventoryReplacementMutation.mutate({
            inventoryKeyId: inventoryReplacementId.trim(),
            apiKey: inventoryReplacementApiKey,
          });
        }}
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
  currentWaitersJoinedInRange: number;
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
  userEmail: string;
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
  upstreamPlanId: string | null;
  status: string;
  revocationRequestedAt: string | null;
  subscriptionExpiresAt: string | null;
};

// The queue row selected for revocation or replacement, kept whole so dialogs
// and toasts can name the work item's provider instead of assuming MiniMax.
// The provider display name is resolved from the catalog at selection time.
type RevocationSelection = {
  workItem: RevocationWorkItem;
  providerDisplayName: string;
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
            {isLoading ? (
              <Skeleton aria-hidden="true" className="h-8 w-40" />
            ) : isError ? null : (
              <p className="text-muted-foreground text-xs leading-5">{item.detail}</p>
            )}
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
          <Table className="min-w-[88rem] table-fixed">
            <colgroup>
              <col className="w-72" />
              <col className="w-36" />
              <col className="w-36" />
              <col className="w-48" />
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
                <TableHead className="text-right">Current waiters joined ({rangeLabel})</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-red-300">
                    Unable to load plan performance.
                  </TableCell>
                </TableRow>
              ) : isLoading || rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground h-24 text-center">
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
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatIntegerValue(row.currentWaitersJoinedInRange)}
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

function formatCurrencyValue(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatIntegerValue(value: number): string {
  return value.toLocaleString('en-US');
}

function formatInsightsRangeLabel(rangeDays: InsightsRangeDays): string {
  return `last ${rangeDays} days`;
}

const SUBSCRIPTION_STATUS_FILTERS: Array<{
  value: SubscriptionDisplayStatus | 'all';
  label: string;
}> = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'pending_cancellation', label: 'Cancellation pending' },
  { value: 'past_due', label: 'Past due' },
  { value: 'canceled', label: 'Canceled' },
];

function SubscriptionsTable({
  items,
  pagination,
  isLoading,
  isFetching,
  isError,
  searchDraft,
  search,
  status,
  onSearchDraftChange,
  onSearch,
  onStatusChange,
  onPageChange,
  onCancel,
  onExtend,
}: {
  items: AdminCodingPlanSubscriptionItem[];
  pagination?: { page: number; total: number; totalPages: number };
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  searchDraft: string;
  search: string;
  status: SubscriptionDisplayStatus | 'all';
  onSearchDraftChange: (value: string) => void;
  onSearch: (value: string) => void;
  onStatusChange: (value: SubscriptionDisplayStatus | 'all') => void;
  onPageChange: (page: number) => void;
  onCancel: (item: AdminCodingPlanSubscriptionItem) => void;
  onExtend: (item: AdminCodingPlanSubscriptionItem) => void;
}) {
  const currentPage = pagination?.page ?? 1;
  const totalPages = Math.max(pagination?.totalPages ?? 1, 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscriptions</CardTitle>
        <CardDescription>Coding Plan subscriptions and billing state.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-3 lg:flex-row lg:items-end"
          onSubmit={event => {
            event.preventDefault();
            onSearch(searchDraft.trim());
          }}
        >
          <div className="space-y-2 lg:w-80">
            <Label htmlFor="coding-plan-subscription-search">Search</Label>
            <Input
              id="coding-plan-subscription-search"
              value={searchDraft}
              onChange={event => onSearchDraftChange(event.target.value)}
              placeholder="User ID or email"
            />
          </div>
          <div className="space-y-2 lg:w-56">
            <Label htmlFor="coding-plan-subscription-status">Status</Label>
            <Select
              value={status}
              onValueChange={value => onStatusChange(value as SubscriptionDisplayStatus | 'all')}
            >
              <SelectTrigger id="coding-plan-subscription-status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {SUBSCRIPTION_STATUS_FILTERS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" className="h-9">
              <Search className="size-4" />
              Search
            </Button>
            {search || searchDraft ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  onSearchDraftChange('');
                  onSearch('');
                }}
              >
                <X className="size-4" />
                Clear
              </Button>
            ) : null}
          </div>
        </form>
        <p className="text-muted-foreground -mt-2 text-xs">
          Search matches a user ID or email address.
        </p>
        {isFetching && !isLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
            <RefreshCw className="size-3 animate-spin" /> Updating results…
          </p>
        ) : null}
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
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-red-300">
                    Unable to load subscriptions.
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
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
                  const canCancel = item.status === 'active' && !item.cancelAtPeriodEnd;
                  const canExtend = item.status === 'active';

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-56 font-mono text-xs">
                        <Link
                          href={`/admin/users/${encodeURIComponent(item.userId)}`}
                          className="text-link hover:text-link-hover underline-offset-4 hover:underline"
                        >
                          {item.userName}
                        </Link>
                        <div className="text-muted-foreground mt-1">{item.userEmail}</div>
                        <div className="text-muted-foreground mt-1">{item.userId}</div>
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
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {canExtend ? (
                            <Button variant="secondary" size="sm" onClick={() => onExtend(item)}>
                              Extend
                            </Button>
                          ) : null}
                          {canCancel ? (
                            <Button variant="destructive" size="sm" onClick={() => onCancel(item)}>
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center">
          <p className="text-muted-foreground">
            {pagination
              ? `${pagination.total.toLocaleString()} subscription${pagination.total === 1 ? '' : 's'} · page ${pagination.page} of ${totalPages}`
              : 'Loading subscription count...'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1 || isFetching}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={!pagination || currentPage >= totalPages || isFetching}
            >
              Next
            </Button>
          </div>
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
  inventoryReplacementId,
  inventoryReplacementApiKey,
  onInventoryReplacementIdChange,
  onInventoryReplacementApiKeyChange,
  onConfirmInventoryReplacement,
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
  onComplete: (workItem: RevocationWorkItem) => void;
  onReplace: (workItem: RevocationWorkItem) => void;
  onProviderChange: (providerId: string) => void;
  onPlanChange: (planId: string) => void;
  onEntriesTextChange: (entriesText: string) => void;
  onUpload: () => void;
  inventoryReplacementId: string;
  inventoryReplacementApiKey: string;
  onInventoryReplacementIdChange: (inventoryKeyId: string) => void;
  onInventoryReplacementApiKeyChange: (apiKey: string) => void;
  onConfirmInventoryReplacement: () => void;
}) {
  const hasSelectedPlan = planOptions.some(plan => plan.planId === selectedPlanId);
  const isBytePlusSelected = selectedProviderId === 'byteplus-coding';

  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-xl p-1 sm:w-fit sm:flex-row sm:items-center">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="revocation-queue">Pending Key Rotation</TabsTrigger>
        <TabsTrigger value="inventory-upload">Upload validated inventory</TabsTrigger>
        <TabsTrigger value="replace-credential">Replace credential</TabsTrigger>
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
                Pending and failed issued credentials requiring action in the provider&apos;s admin
                console. Revoke removes stock permanently; Replace validates a newly generated key
                for the same upstream assignment.
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
                    <TableHead>Upstream identifier</TableHead>
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
                          <div>
                            {getCodingPlanProviderDisplayName(providerOptions, item.providerId)}
                          </div>
                          <div className="text-muted-foreground mt-1">{item.planId}</div>
                        </TableCell>
                        <TableCell className="min-w-44 font-mono text-xs">
                          {item.upstreamPlanId ?? '—'}
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
                              onClick={() => onComplete(item)}
                            >
                              Revoke
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => onReplace(item)}>
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
              Choose the BYOK provider ID and Kilo plan for this batch. Enter one{' '}
              <code>
                {isBytePlusSelected
                  ? '<api key>::<assigned BytePlus username>'
                  : '<api key>::<upstream plan id>'}
              </code>{' '}
              pair per line.
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
              <Label htmlFor="coding-plan-entries">
                {isBytePlusSelected
                  ? 'API keys and assigned BytePlus usernames'
                  : 'API keys and upstream plan IDs'}
              </Label>
              <Textarea
                id="coding-plan-entries"
                value={entriesText}
                onChange={event => onEntriesTextChange(event.target.value)}
                placeholder={
                  isBytePlusSelected
                    ? '<api key>::<assigned BytePlus username>'
                    : '<api key>::<upstream plan id>'
                }
                className="min-h-28 font-mono"
                autoComplete="off"
              />
            </div>
            <Alert>
              <ShieldAlert className="size-4" />
              <AlertDescription>
                API keys are encrypted after validation and are never returned or displayed. The
                upstream identifier is retained for provider-side operations and appears in the
                Pending Key Rotation queue. BytePlus usernames are used to verify the assigned seat
                and are not displayed after upload.
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

      <TabsContent value="replace-credential" className="mt-0">
        <Card>
          <CardHeader>
            <CardTitle>Replace inventory credential</CardTitle>
            <CardDescription>
              Replace the API key for an available or assigned inventory ID. Kilo validates the key,
              encrypts it, and updates any assigned BYOK copy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inventory-replacement-id">Inventory ID</Label>
              <Input
                id="inventory-replacement-id"
                value={inventoryReplacementId}
                onChange={event => onInventoryReplacementIdChange(event.target.value)}
                placeholder="Inventory UUID"
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inventory-replacement-api-key">Replacement API key</Label>
              <Input
                id="inventory-replacement-api-key"
                type="password"
                value={inventoryReplacementApiKey}
                onChange={event => onInventoryReplacementApiKeyChange(event.target.value)}
                placeholder={getInventoryReplacementDialogCopy().placeholder}
                autoComplete="off"
              />
            </div>
            <Alert>
              <ShieldAlert className="size-4" />
              <AlertDescription>{getInventoryReplacementDialogCopy().description}</AlertDescription>
            </Alert>
            <Button
              onClick={onConfirmInventoryReplacement}
              disabled={
                inventoryReplacementId.trim().length === 0 ||
                inventoryReplacementApiKey.trim().length === 0
              }
            >
              Review replacement
            </Button>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function OperationsDialogs({
  completeSelection,
  completePending,
  replacementSelection,
  replacementApiKey,
  replacementPending,
  onCloseComplete,
  onComplete,
  onCloseReplacement,
  onReplacementApiKeyChange,
  onReplace,
  cancelSelection,
  cancelPending,
  onCloseCancel,
  onCancel,
  extendSelection,
  extendDays,
  extendPending,
  canSubmitExtend,
  onCloseExtend,
  onExtendDaysChange,
  onExtend,
  inventoryReplacementId,
  inventoryReplacementConfirmOpen,
  inventoryReplacementPending,
  onCloseInventoryReplacement,
  onReplaceInventoryCredential,
}: {
  completeSelection: RevocationSelection | null;
  completePending: boolean;
  replacementSelection: RevocationSelection | null;
  replacementApiKey: string;
  replacementPending: boolean;
  onCloseComplete: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onCloseReplacement: () => void;
  onReplacementApiKeyChange: (apiKey: string) => void;
  onReplace: (inventoryKeyId: string, apiKey: string) => void;
  cancelSelection: AdminCodingPlanSubscriptionItem | null;
  cancelPending: boolean;
  onCloseCancel: () => void;
  onCancel: (subscriptionId: string) => void;
  extendSelection: AdminCodingPlanSubscriptionItem | null;
  extendDays: string;
  extendPending: boolean;
  canSubmitExtend: boolean;
  onCloseExtend: () => void;
  onExtendDaysChange: (days: string) => void;
  onExtend: (subscriptionId: string, days: number) => void;
  inventoryReplacementId: string;
  inventoryReplacementConfirmOpen: boolean;
  inventoryReplacementPending: boolean;
  onCloseInventoryReplacement: () => void;
  onReplaceInventoryCredential: () => void;
}) {
  // Copy derives from the retained selection. The null fallback only applies
  // while a dialog is closed or animating out, so it is never visible.
  const revocationCopy = getRevocationDialogCopy(
    completeSelection?.providerDisplayName ?? 'the provider'
  );
  const replacementCopy = getReplacementDialogCopy(
    replacementSelection?.providerDisplayName ?? 'the provider'
  );
  const cancelCopy = getCancelSubscriptionDialogCopy(cancelSelection?.userName ?? 'this user');
  const extendCopy = getExtendSubscriptionDialogCopy(extendSelection?.userName ?? 'this user');
  const parsedExtendDays = Number(extendDays);
  const inventoryReplacementCopy = getInventoryReplacementDialogCopy(inventoryReplacementId);

  return (
    <>
      <Dialog
        open={completeSelection !== null}
        onOpenChange={open => {
          if (!open && !completePending) onCloseComplete();
        }}
      >
        <DialogContent showCloseButton={!completePending}>
          <DialogHeader>
            <DialogTitle>{revocationCopy.title}</DialogTitle>
            <DialogDescription>{revocationCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseComplete} disabled={completePending}>
              Keep pending
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                completeSelection && onComplete(completeSelection.workItem.inventoryKeyId)
              }
              disabled={completePending}
            >
              {completePending ? 'Revoking...' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={replacementSelection !== null}
        onOpenChange={open => {
          if (!open && !replacementPending) onCloseReplacement();
        }}
      >
        <DialogContent showCloseButton={!replacementPending}>
          <DialogHeader>
            <DialogTitle>{replacementCopy.title}</DialogTitle>
            <DialogDescription>{replacementCopy.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="replacement-api-key">Replacement API key</Label>
            <Input
              id="replacement-api-key"
              type="password"
              value={replacementApiKey}
              onChange={event => onReplacementApiKeyChange(event.target.value)}
              autoComplete="off"
              placeholder={replacementCopy.placeholder}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseReplacement} disabled={replacementPending}>
              Keep pending
            </Button>
            <Button
              onClick={() =>
                replacementSelection &&
                onReplace(replacementSelection.workItem.inventoryKeyId, replacementApiKey)
              }
              disabled={replacementApiKey.trim().length === 0 || replacementPending}
            >
              {replacementPending ? 'Validating...' : 'Validate and replace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelSelection !== null}
        onOpenChange={open => {
          if (!open && !cancelPending) onCloseCancel();
        }}
      >
        <DialogContent showCloseButton={!cancelPending}>
          <DialogHeader>
            <DialogTitle>{cancelCopy.title}</DialogTitle>
            <DialogDescription>{cancelCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseCancel} disabled={cancelPending}>
              Keep subscription
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelSelection && onCancel(cancelSelection.id)}
              disabled={cancelPending}
            >
              {cancelPending ? 'Scheduling cancellation...' : 'Cancel at period end'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={extendSelection !== null}
        onOpenChange={open => {
          if (!open && !extendPending) onCloseExtend();
        }}
      >
        <DialogContent showCloseButton={!extendPending}>
          <DialogHeader>
            <DialogTitle>{extendCopy.title}</DialogTitle>
            <DialogDescription>{extendCopy.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="extend-subscription-days">Additional days</Label>
            <Input
              id="extend-subscription-days"
              type="number"
              min={1}
              max={90}
              value={extendDays}
              onChange={event => onExtendDaysChange(event.target.value)}
            />
            {extendSelection ? (
              <p className="text-muted-foreground text-xs">
                Current period ends {formatDateLabel(extendSelection.currentPeriodEnd)}. Renewal is{' '}
                {formatDateLabel(extendSelection.creditRenewalAt)}.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseExtend} disabled={extendPending}>
              Keep dates
            </Button>
            <Button
              onClick={() =>
                extendSelection && canSubmitExtend && onExtend(extendSelection.id, parsedExtendDays)
              }
              disabled={!canSubmitExtend || extendPending}
            >
              {extendPending ? 'Extending period...' : 'Extend period'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inventoryReplacementConfirmOpen}
        onOpenChange={open => {
          if (!open && !inventoryReplacementPending) onCloseInventoryReplacement();
        }}
      >
        <DialogContent showCloseButton={!inventoryReplacementPending}>
          <DialogHeader>
            <DialogTitle>{inventoryReplacementCopy.title}</DialogTitle>
            <DialogDescription>{inventoryReplacementCopy.description}</DialogDescription>
          </DialogHeader>
          <p className="font-mono text-sm">{inventoryReplacementId.trim()}</p>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={onCloseInventoryReplacement}
              disabled={inventoryReplacementPending}
            >
              Keep current key
            </Button>
            <Button onClick={onReplaceInventoryCredential} disabled={inventoryReplacementPending}>
              {inventoryReplacementPending ? 'Validating...' : 'Validate and replace'}
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
