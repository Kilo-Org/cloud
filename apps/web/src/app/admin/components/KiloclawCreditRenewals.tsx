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

const CONFIRMATION = 'STOP CREDIT RENEWALS';

export function KiloclawCreditRenewals() {
  const { isSuperadmin } = useAdminPermissions();
  return isSuperadmin ? <CreditRenewalControls /> : null;
}

function CreditRenewalControls() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const preview = useQuery(trpc.admin.kiloclawCreditRenewals.preview.queryOptions());
  const refreshPreview = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawCreditRenewals.preview.queryKey(),
    });
  const stop = useMutation(
    trpc.admin.kiloclawCreditRenewals.stop.mutationOptions({
      onSuccess: () => {
        setDialogOpen(false);
        setConfirmation('');
      },
      onSettled: refreshPreview,
    })
  );
  const renewing = preview.data?.renewing ?? 0;
  const ending = preview.data?.ending ?? 0;
  const error = preview.error ?? stop.error;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="credit-renewals-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl space-y-1">
          <h2 id="credit-renewals-title" className="font-semibold">
            Credit subscription renewals
          </h2>
          <p className="text-muted-foreground text-sm">
            Stop renewal for all credit-paid KiloClaw subscriptions. Access continues until the
            current credit period ends.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={preview.isPending || preview.isError || stop.isPending || renewing === 0}
          onClick={() => {
            setConfirmation('');
            stop.reset();
            setDialogOpen(true);
          }}
        >
          Stop all credit renewals
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Credit renewal action needs attention</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            {preview.isError && (
              <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
                Reload preview
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {preview.data && (
        <p className="text-muted-foreground text-sm tabular-nums">
          {renewing} renewing, {ending} already ending.
        </p>
      )}

      {stop.data && (
        <p role="status" className="text-sm tabular-nums">
          {stop.data.remaining
            ? `Stopped ${stop.data.updated}; more remain — run again.`
            : `Stopped ${stop.data.updated}.`}
        </p>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop all credit subscription renewals?</DialogTitle>
            <DialogDescription>
              This ends each subscription at the end of its current credit period. It does not issue
              refunds or immediately shut down instances. Stripe-paid subscriptions are not
              affected.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm tabular-nums">
            <strong>{renewing}</strong> credit subscriptions are currently renewing and will end at
            the end of their current period. {ending} already ending.
          </p>
          <div className="space-y-2">
            <Label htmlFor="credit-renewals-confirmation">Type {CONFIRMATION} to confirm</Label>
            <Input
              id="credit-renewals-confirmation"
              value={confirmation}
              autoComplete="off"
              disabled={stop.isPending}
              onChange={event => setConfirmation(event.target.value)}
            />
          </div>
          {stop.error && (
            <p role="alert" className="text-destructive text-sm">
              {stop.error.message}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button
              variant="destructive"
              disabled={renewing === 0 || confirmation !== CONFIRMATION || stop.isPending}
              onClick={() => stop.mutate({ confirmation: CONFIRMATION })}
            >
              {stop.isPending ? 'Stopping...' : 'Stop all credit renewals'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
