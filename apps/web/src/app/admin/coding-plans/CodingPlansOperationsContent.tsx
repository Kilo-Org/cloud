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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';

const PLAN_ID = 'minimax-token-plan-plus';

type OperationsState = {
  keysText: string;
  revealInventoryId: string | null;
  revealedCredential: string | null;
  completeInventoryId: string | null;
  failureInventoryId: string | null;
  failureReason: string;
};

const INITIAL_OPERATIONS_STATE: OperationsState = {
  keysText: '',
  revealInventoryId: null,
  revealedCredential: null,
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
    keysText,
    revealInventoryId,
    revealedCredential,
    completeInventoryId,
    failureInventoryId,
    failureReason,
  } = state;
  const setKeysText = (keysText: string) => updateState({ keysText });
  const setRevealInventoryId = (revealInventoryId: string | null) =>
    updateState({ revealInventoryId });
  const setRevealedCredential = (revealedCredential: string | null) =>
    updateState({ revealedCredential });
  const setCompleteInventoryId = (completeInventoryId: string | null) =>
    updateState({ completeInventoryId });
  const setFailureInventoryId = (failureInventoryId: string | null) =>
    updateState({ failureInventoryId });
  const setFailureReason = (failureReason: string) => updateState({ failureReason });

  const countsQuery = useQuery(trpc.codingPlans.adminKeyInventory.queryOptions({}));
  const queueQuery = useQuery(trpc.codingPlans.adminRevocationQueue.queryOptions({}));

  const refreshOperations = async () => {
    await Promise.all([countsQuery.refetch(), queueQuery.refetch()]);
  };

  const uploadMutation = useMutation(
    trpc.codingPlans.adminUploadKeys.mutationOptions({
      onSuccess: async result => {
        setKeysText('');
        toast.success(
          `${result.inserted} validated credential${result.inserted === 1 ? '' : 's'} added to inventory.`
        );
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Credential validation or upload failed.'),
    })
  );
  const revealMutation = useMutation(
    trpc.codingPlans.adminRevealRevocationCredential.mutationOptions({
      onSuccess: result => setRevealedCredential(result.apiKey),
      onError: error => toast.error(error.message || 'Credential reveal failed.'),
    })
  );
  const completeMutation = useMutation(
    trpc.codingPlans.adminMarkRevocationComplete.mutationOptions({
      onSuccess: async () => {
        closeRevealDialog();
        setCompleteInventoryId(null);
        toast.success('Credential marked revoked. Stored secret material cleared.');
        await refreshOperations();
      },
      onError: error => toast.error(error.message || 'Unable to mark credential revoked.'),
    })
  );
  const failureMutation = useMutation(
    trpc.codingPlans.adminMarkRevocationFailed.mutationOptions({
      onSuccess: async () => {
        closeRevealDialog();
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

  const submittedKeys = keysText
    .split('\n')
    .map(key => key.trim())
    .filter(key => key.length > 0);
  const workItems = queueQuery.data ?? [];
  const inventoryCounts = countsQuery.data ?? [];
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

  function closeRevealDialog() {
    setRevealInventoryId(null);
    setRevealedCredential(null);
    revealMutation.reset();
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Coding plans operations</h2>
          <p className="text-muted-foreground max-w-4xl text-sm">
            Manage validated Token Plan Plus inventory and manual MiniMax credential revocation.
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

      <OperationsTabs
        workItems={workItems}
        queueLoading={queueQuery.isLoading}
        queueError={queueQuery.isError}
        keysText={keysText}
        submittedKeys={submittedKeys}
        uploadPending={uploadMutation.isPending}
        requeuePending={requeueMutation.isPending}
        onRefresh={() => void refreshOperations()}
        onReveal={setRevealInventoryId}
        onComplete={setCompleteInventoryId}
        onFailure={setFailureInventoryId}
        onRequeue={inventoryKeyId => requeueMutation.mutate({ inventoryKeyId })}
        onKeysTextChange={setKeysText}
        onUpload={() => uploadMutation.mutate({ planId: PLAN_ID, keys: submittedKeys })}
      />

      <OperationsDialogs
        revealInventoryId={revealInventoryId}
        revealedCredential={revealedCredential}
        revealPending={revealMutation.isPending}
        completeInventoryId={completeInventoryId}
        completePending={completeMutation.isPending}
        failureInventoryId={failureInventoryId}
        failureReason={failureReason}
        failurePending={failureMutation.isPending}
        onCloseReveal={closeRevealDialog}
        onReveal={inventoryKeyId => revealMutation.mutate({ inventoryKeyId })}
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

type RevocationWorkItem = {
  inventoryKeyId: string;
  planId: string;
  status: string;
  revocationRequestedAt: string | null;
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

function OperationsTabs({
  workItems,
  queueLoading,
  queueError,
  keysText,
  submittedKeys,
  uploadPending,
  requeuePending,
  onRefresh,
  onReveal,
  onComplete,
  onFailure,
  onRequeue,
  onKeysTextChange,
  onUpload,
}: {
  workItems: RevocationWorkItem[];
  queueLoading: boolean;
  queueError: boolean;
  keysText: string;
  submittedKeys: string[];
  uploadPending: boolean;
  requeuePending: boolean;
  onRefresh: () => void;
  onReveal: (inventoryKeyId: string) => void;
  onComplete: (inventoryKeyId: string) => void;
  onFailure: (inventoryKeyId: string) => void;
  onRequeue: (inventoryKeyId: string) => void;
  onKeysTextChange: (keysText: string) => void;
  onUpload: () => void;
}) {
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
                    <TableHead>Status</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Latest failure</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueError ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-red-300">
                        Unable to load manual revocation work. Refresh to retry.
                      </TableCell>
                    </TableRow>
                  ) : workItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                        {queueLoading ? 'Loading manual work...' : 'No revocation work pending.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    workItems.map(item => (
                      <TableRow key={item.inventoryKeyId}>
                        <TableCell className="min-w-56 font-mono text-xs">
                          <div>{item.inventoryKeyId}</div>
                          <div className="text-muted-foreground mt-1">{item.planId}</div>
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
                              onClick={() => onReveal(item.inventoryKeyId)}
                            >
                              Reveal
                            </Button>
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
              Enter one MiniMax credential per line. Each credential is tested through ordinary
              MiniMax routing before encrypted storage as available inventory.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="coding-plan-keys">MiniMax credentials</Label>
              <Textarea
                id="coding-plan-keys"
                value={keysText}
                onChange={event => onKeysTextChange(event.target.value)}
                placeholder="Enter one credential per line"
                className="min-h-28 font-mono"
                autoComplete="off"
              />
            </div>
            <Alert>
              <ShieldAlert className="size-4" />
              <AlertDescription>
                Values are encrypted after validation and never returned by inventory or queue APIs.
              </AlertDescription>
            </Alert>
            <Button
              onClick={onUpload}
              disabled={submittedKeys.length === 0 || uploadPending}
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
  revealInventoryId,
  revealedCredential,
  revealPending,
  completeInventoryId,
  completePending,
  failureInventoryId,
  failureReason,
  failurePending,
  onCloseReveal,
  onReveal,
  onCloseComplete,
  onComplete,
  onCloseFailure,
  onFailureReasonChange,
  onFailure,
}: {
  revealInventoryId: string | null;
  revealedCredential: string | null;
  revealPending: boolean;
  completeInventoryId: string | null;
  completePending: boolean;
  failureInventoryId: string | null;
  failureReason: string;
  failurePending: boolean;
  onCloseReveal: () => void;
  onReveal: (inventoryKeyId: string) => void;
  onCloseComplete: () => void;
  onComplete: (inventoryKeyId: string) => void;
  onCloseFailure: () => void;
  onFailureReasonChange: (reason: string) => void;
  onFailure: (inventoryKeyId: string, reason: string) => void;
}) {
  return (
    <>
      <Dialog open={revealInventoryId !== null} onOpenChange={open => !open && onCloseReveal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reveal issued credential?</DialogTitle>
            <DialogDescription>
              Sensitive data: reveal only while actively revoking this issued credential in MiniMax.
              Do not paste it into tickets, chat, logs, or failure notes.
            </DialogDescription>
          </DialogHeader>
          {revealedCredential ? (
            <div className="space-y-2">
              <Label>Issued MiniMax credential</Label>
              <pre className="bg-background overflow-x-auto rounded-md border p-3 font-mono text-sm">
                {revealedCredential}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={onCloseReveal}>
              Close
            </Button>
            {revealedCredential ? null : (
              <Button
                variant="destructive"
                onClick={() => revealInventoryId && onReveal(revealInventoryId)}
                disabled={revealPending}
              >
                {revealPending ? 'Revealing...' : 'Reveal credential'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={completeInventoryId !== null} onOpenChange={open => !open && onCloseComplete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record confirmed revocation?</DialogTitle>
            <DialogDescription>
              Confirm only after MiniMax revocation succeeds. Kilo marks this credential revoked and
              permanently clears retained encrypted material.
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
