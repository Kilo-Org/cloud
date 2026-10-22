'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAdminPermissions } from '@/app/admin/useAdminPermissions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { useTRPC } from '@/lib/trpc/utils';

const CONFIRMATION = 'STOP STRIPE RENEWALS';

export function KiloclawStripeRenewals() {
  const { isSuperadmin } = useAdminPermissions();
  return isSuperadmin ? <StripeRenewalControls /> : null;
}

function StripeRenewalControls() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const status = useQuery({
    ...trpc.admin.kiloclawStripeRenewals.status.queryOptions(),
    refetchInterval: query => (query.state.data?.run?.status === 'running' ? 5_000 : 15_000),
  });
  const refreshStatus = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawStripeRenewals.status.queryKey(),
    });
  const preview = useMutation(trpc.admin.kiloclawStripeRenewals.preview.mutationOptions());
  const start = useMutation(
    trpc.admin.kiloclawStripeRenewals.start.mutationOptions({
      onSuccess: () => {
        setDialogOpen(false);
        setConfirmation('');
        preview.reset();
      },
      onSettled: refreshStatus,
    })
  );
  const retry = useMutation(
    trpc.admin.kiloclawStripeRenewals.retry.mutationOptions({ onSettled: refreshStatus })
  );
  const run = status.data?.run;
  const running = run?.status === 'running';
  const error = start.error ?? retry.error ?? preview.error ?? status.error;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="stripe-renewals-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl space-y-1">
          <h2 id="stripe-renewals-title" className="font-semibold">
            Stripe subscription renewals
          </h2>
          <p className="text-muted-foreground text-sm">
            Stop renewal for all Stripe-backed KiloClaw subscriptions, including hybrid plans. Paid
            access continues until the current term ends. Pure-credit subscriptions are not changed.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            status.isPending || status.isError || running || preview.isPending || start.isPending
          }
          onClick={() => {
            setConfirmation('');
            start.reset();
            retry.reset();
            preview.reset();
            setDialogOpen(true);
            preview.mutate();
          }}
        >
          {preview.isPending ? 'Preparing preview...' : 'Stop all Stripe renewals'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Stripe renewal action needs attention</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            {status.isError && (
              <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
                Reload status
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {run && (
        <div className="space-y-2 text-sm">
          <p role="status" className="tabular-nums">
            {running ? 'Processing' : 'Batch finished'}: {run.processed} / {run.total}{' '}
            subscriptions. {run.updated} updated, {run.skipped} already stopped, {run.failed}{' '}
            failed.
          </p>
          {running && (
            <p className="text-muted-foreground">
              This batch continues in the background. You can leave this page.
            </p>
          )}
          {!running && run.failed > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={retry.isPending || start.isPending}
              onClick={() => retry.mutate({ runId: run.id })}
            >
              {retry.isPending ? 'Retrying...' : 'Retry failed subscriptions'}
            </Button>
          )}
          {run.failures.length > 0 && (
            <details>
              <summary className="cursor-pointer">Failed subscriptions</summary>
              <ul className="mt-2 space-y-1">
                {run.failures.map(failure => (
                  <li key={failure.stripeSubscriptionId} className="break-words">
                    <code>{failure.stripeSubscriptionId}</code>: {failure.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-muted-foreground break-all text-xs">Batch: {run.id}</p>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Stop all KiloClaw Stripe renewals?</DialogTitle>
            <DialogDescription>
              This stops Stripe renewal after each subscription&apos;s current term. It does not
              issue refunds or immediately shut down instances. Other Kilo products are not
              affected.
            </DialogDescription>
          </DialogHeader>
          {preview.isPending && <p role="status">Preparing subscription preview...</p>}
          {preview.error && (
            <p role="alert" className="text-destructive text-sm">
              {preview.error.message}
            </p>
          )}
          {preview.data && (
            <div className="space-y-4">
              <p className="text-sm tabular-nums">
                <strong>{preview.data.total}</strong> Stripe-backed subscriptions will be checked.
                Subscriptions already canceled or ending by the current term are left stopped.
                Attached plan schedules are released where needed.
              </p>
              <p className="text-muted-foreground text-sm">
                This is a one-time batch, not a permanent renewal lock. Previously requested
                conversions to credit billing are preserved and can continue service and debit
                credits after Stripe billing ends.
              </p>
              <div className="space-y-2">
                <Label htmlFor="stripe-renewals-confirmation">Type {CONFIRMATION} to confirm</Label>
                <Input
                  id="stripe-renewals-confirmation"
                  value={confirmation}
                  autoComplete="off"
                  disabled={start.isPending}
                  onChange={event => setConfirmation(event.target.value)}
                />
              </div>
            </div>
          )}
          {start.error && (
            <p role="alert" className="text-destructive text-sm">
              {start.error.message}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button
              variant="destructive"
              disabled={
                !preview.data?.total || confirmation !== CONFIRMATION || start.isPending || running
              }
              onClick={() => {
                if (!preview.data || confirmation !== CONFIRMATION) return;
                start.mutate({
                  previewId: preview.data.id,
                  confirmation,
                  reason: 'KiloClaw end of life',
                });
              }}
            >
              {start.isPending ? 'Starting batch...' : 'Stop all Stripe renewals'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
