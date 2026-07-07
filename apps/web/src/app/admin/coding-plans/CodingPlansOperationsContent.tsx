'use client';

import { useReducer } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
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
import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { CodingPlanId } from '@/lib/coding-plans/pricing';
import { useTRPC } from '@/lib/trpc/utils';

type OperationsState = {
  providerId: UserByokProviderId;
  planId: CodingPlanId;
  entriesText: string;
  completeInventoryId: string | null;
  failureInventoryId: string | null;
  failureReason: string;
};

const INITIAL_OPERATIONS_STATE: OperationsState = {
  providerId: 'minimax',
  planId: 'minimax-token-plan-plus',
  entriesText: '',
  completeInventoryId: null,
  failureInventoryId: null,
  failureReason: '',
};

function updateOperationsState(state: OperationsState, update: Partial<OperationsState>) {
  return { ...state, ...update };
}

export function CodingPlansOperationsContent() {
  const trpc = useTRPC();
  const [state, updateState] = useReducer(updateOperationsState, INITIAL_OPERATIONS_STATE);
  const {
    providerId,
    planId,
    entriesText,
    completeInventoryId,
    failureInventoryId,
    failureReason,
  } = state;
  const setProviderId = (providerId: UserByokProviderId) => updateState({ providerId });
  const setPlanId = (planId: CodingPlanId) => updateState({ planId });
  const setEntriesText = (entriesText: string) => updateState({ entriesText });
  const setCompleteInventoryId = (completeInventoryId: string | null) =>
    updateState({ completeInventoryId });
  const setFailureInventoryId = (failureInventoryId: string | null) =>
    updateState({ failureInventoryId });
  const setFailureReason = (failureReason: string) => updateState({ failureReason });

  const countsQuery = useQuery(trpc.codingPlans.adminKeyInventory.queryOptions({}));
  const queueQuery = useQuery(trpc.codingPlans.adminRevocationQueue.queryOptions({}));
  const catalogQuery = useQuery(trpc.codingPlans.catalog.queryOptions());

  const refreshOperations = async () => {
    await Promise.all([countsQuery.refetch(), queueQuery.refetch()]);
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
        toast.success('MiniMax plan marked revoked.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to mark credential revoked.'),
    })
  );
  const failureMutation = useMutation(
    trpc.codingPlans.adminMarkRevocationFailed.mutationOptions({
      onSuccess: async () => {
        setFailureInventoryId(null);
        setFailureReason('');
        toast.success('Revocation failure recorded for retry.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to record revocation failure.'),
    })
  );
  const requeueMutation = useMutation(
    trpc.codingPlans.adminRequeueRevocation.mutationOptions({
      onSuccess: async () => {
        toast.success('Credential requeued for manual revocation.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to requeue credential.'),
    })
  );

  const submittedEntries = entriesText
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const workItems = queueQuery.data ?? [];
  const inventoryCounts = countsQuery.data ?? [];
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
      detail: 'All inventory states',
    },
    {
      label: 'Available credentials in system',
      count: countCredentialsByStatus('available'),
      detail: 'Ready for assignment',
    },
    {
      label: 'Revoked credentials',
      count: countCredentialsByStatus('revoked'),
      detail: 'Confirmed complete',
    },
    {
      label: 'Pending revocation credentials',
      count: countCredentialsByStatus('revocation_pending'),
      detail: 'Awaiting manual action',
    },
  ];

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Coding plans operations</h2>
          <p className="text-muted-foreground max-w-4xl text-sm">
            Manage validated MiniMax Coding Plan inventory and manual credential revocation.
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

      <InventorySummaryCards
        items={inventorySummary}
        isLoading={countsQuery.isLoading}
        isError={countsQuery.isError}
      />

      <InventoryCountsTable
        items={inventoryCounts}
        isLoading={countsQuery.isLoading}
        isError={countsQuery.isError}
      />

      <OperationsTabs
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
        requeuePending={requeueMutation.isPending}
        onRefresh={() => void refreshOperations()}
        onComplete={setCompleteInventoryId}
        onFailure={setFailureInventoryId}
        onRequeue={inventoryKeyId => requeueMutation.mutate({ inventoryKeyId })}
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

      <OperationsDialogs
        completeInventoryId={completeInventoryId}
        completePending={completeMutation.isPending}
        failureInventoryId={failureInventoryId}
        failureReason={failureReason}
        failurePending={failureMutation.isPending}
        onCloseComplete={() => setCompleteInventoryId(null)}
        onComplete={inventoryKeyId => completeMutation.mutate({ inventoryKeyId })}
        onCloseFailure={() => setFailureInventoryId(null)}
        onFailureReasonChange={setFailureReason}
        onFailure={(inventoryKeyId, reason) => failureMutation.mutate({ inventoryKeyId, reason })}
      />
    </div>
  );
}

type InventorySummaryItem = {
  label: string;
  count: number;
  detail: string;
};

type InventoryCountItem = {
  providerId: string;
  planId: string;
  status: string;
  count: number;
};

type RevocationWorkItem = {
  inventoryKeyId: string;
  providerId: string;
  planId: string;
  upstreamPlanId: string;
  status: string;
  revocationRequestedAt: string | null;
  subscriptionExpiresAt: string | null;
  revocationAttemptCount: number;
  lastRevocationError: string | null;
};

function InventorySummaryCards({
  items,
  isLoading,
  isError,
}: {
  items: InventorySummaryItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Credential summary">
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
            <p className="text-muted-foreground text-xs">{summary.detail}</p>
          </CardContent>
        </Card>
      ))}
    </section>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventory counts</CardTitle>
        <CardDescription>
          Credential inventory grouped by provider, plan, and status.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-red-300">
                    Unable to load inventory counts.
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground h-24 text-center">
                    {isLoading ? 'Loading inventory counts...' : 'No inventory recorded.'}
                  </TableCell>
                </TableRow>
              ) : (
                items.map(item => (
                  <TableRow key={`${item.providerId}:${item.planId}:${item.status}`}>
                    <TableCell className="font-mono text-xs">{item.providerId}</TableCell>
                    <TableCell className="font-mono text-xs">{item.planId}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{formatStatus(item.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {item.count}
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

function OperationsTabs({
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
  requeuePending,
  onRefresh,
  onComplete,
  onFailure,
  onRequeue,
  onProviderChange,
  onPlanChange,
  onEntriesTextChange,
  onUpload,
}: {
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
  requeuePending: boolean;
  onRefresh: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onFailure: (inventoryKeyId: string) => void;
  onRequeue: (inventoryKeyId: string) => void;
  onProviderChange: (providerId: string) => void;
  onPlanChange: (planId: string) => void;
  onEntriesTextChange: (entriesText: string) => void;
  onUpload: () => void;
}) {
  const hasSelectedPlan = planOptions.some(plan => plan.planId === selectedPlanId);

  return (
    <Tabs defaultValue="revocation-queue" className="space-y-4">
      <TabsList className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-xl p-1 sm:w-fit sm:flex-row sm:items-center">
        <TabsTrigger value="revocation-queue">Manual revocation queue</TabsTrigger>
        <TabsTrigger value="inventory-upload">Upload validated inventory</TabsTrigger>
      </TabsList>

      <TabsContent value="revocation-queue" className="mt-0">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Manual revocation queue</CardTitle>
              <CardDescription>
                Pending and failed issued credentials requiring action in MiniMax admin tooling.
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
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Latest failure</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueError ? (
                    <TableRow>
                      <TableCell colSpan={9} className="h-24 text-center text-red-300">
                        Unable to load manual revocation work. Refresh to retry.
                      </TableCell>
                    </TableRow>
                  ) : workItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
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
                        <TableCell className="text-right font-mono tabular-nums">
                          {item.revocationAttemptCount}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-72 text-sm">
                          {item.lastRevocationError ?? 'None'}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onComplete(item.inventoryKeyId)}
                            >
                              Mark revoked
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onFailure(item.inventoryKeyId)}
                            >
                              Mark failed
                            </Button>
                            {item.status === 'revocation_failed' ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onRequeue(item.inventoryKeyId)}
                                disabled={requeuePending}
                              >
                                Requeue
                              </Button>
                            ) : null}
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
  failureInventoryId,
  failureReason,
  failurePending,
  onCloseComplete,
  onComplete,
  onCloseFailure,
  onFailureReasonChange,
  onFailure,
}: {
  completeInventoryId: string | null;
  completePending: boolean;
  failureInventoryId: string | null;
  failureReason: string;
  failurePending: boolean;
  onCloseComplete: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onCloseFailure: () => void;
  onFailureReasonChange: (reason: string) => void;
  onFailure: (inventoryKeyId: string, reason: string) => void;
}) {
  return (
    <>
      <Dialog open={completeInventoryId !== null} onOpenChange={open => !open && onCloseComplete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record confirmed revocation?</DialogTitle>
            <DialogDescription>
              Confirm only after MiniMax deprovisioning succeeds. Kilo records this plan ID as
              revoked and keeps issued credentials unavailable for reuse.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseComplete}>
              Keep pending
            </Button>
            <Button
              onClick={() => completeInventoryId && onComplete(completeInventoryId)}
              disabled={completePending}
            >
              {completePending ? 'Recording...' : 'Record revoked'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={failureInventoryId !== null} onOpenChange={open => !open && onCloseFailure()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record revocation failure</DialogTitle>
            <DialogDescription>
              Store a sanitized operational explanation only. Never include a credential, auth
              header, or provider response body.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="revocation-failure-reason">Sanitized failure reason</Label>
            <Textarea
              id="revocation-failure-reason"
              value={failureReason}
              onChange={event => onFailureReasonChange(event.target.value)}
              maxLength={300}
              placeholder="Example: Provider admin console was unavailable during support attempt."
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseFailure}>
              Keep pending
            </Button>
            <Button
              variant="destructive"
              onClick={() => failureInventoryId && onFailure(failureInventoryId, failureReason)}
              disabled={failureReason.trim().length === 0 || failurePending}
            >
              {failurePending ? 'Recording...' : 'Record failure'}
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

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}
