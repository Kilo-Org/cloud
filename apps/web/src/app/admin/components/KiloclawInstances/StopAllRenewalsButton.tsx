'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const CONFIRMATION_PHRASE = 'STOP RENEWALS';

type BulkCancelResult = {
  total: number;
  updated: number;
  skipped: number;
  failed: { subscriptionId: string; userId: string; error: string }[];
  noRenewalPeriod: { subscriptionId: string; userId: string }[];
};

export function StopAllRenewalsButton() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<BulkCancelResult | null>(null);

  const preview = useQuery({
    ...trpc.admin.users.previewBulkCancelKiloClawSubscriptions.queryOptions(),
    enabled: open,
  });

  const bulkCancel = useMutation(
    trpc.admin.users.bulkCancelKiloClawSubscriptions.mutationOptions({
      onSuccess(data) {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.users.previewBulkCancelKiloClawSubscriptions.queryKey(),
        });
        setResult(data);
      },
    })
  );

  const closeConfirm = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setConfirmation('');
  };

  const breakdown = preview.data;
  const canSubmit =
    confirmation === CONFIRMATION_PHRASE && !bulkCancel.isPending && (breakdown?.total ?? 0) > 0;

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={bulkCancel.isPending}
      >
        {bulkCancel.isPending ? 'Stopping renewals...' : 'Stop renewal for all subscriptions'}
      </Button>

      <AlertDialog open={open} onOpenChange={closeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop renewal for all KiloClaw subscriptions?</AlertDialogTitle>
            <AlertDialogDescription>
              Sets cancel at period end on every active and past-due subscription, in Stripe and
              locally. Access continues until each current period ends. No dates or statuses change.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {preview.isPending ? (
            <p className="text-muted-foreground text-sm">Loading eligible subscriptions...</p>
          ) : preview.isError ? (
            <p className="text-destructive text-sm">Failed to load eligible subscriptions.</p>
          ) : breakdown ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Eligible</dt>
              <dd className="font-medium">{breakdown.total}</dd>
              <dt className="text-muted-foreground">Active / past due</dt>
              <dd>
                {breakdown.byStatus.active} / {breakdown.byStatus.past_due}
              </dd>
              <dt className="text-muted-foreground">Personal / organization</dt>
              <dd>
                {breakdown.byOwnership.personal} / {breakdown.byOwnership.organization}
              </dd>
              <dt className="text-muted-foreground">Stripe / credits</dt>
              <dd>
                {breakdown.byFunding.stripe} / {breakdown.byFunding.credits}
              </dd>
              <dt className="text-muted-foreground">No renewal period</dt>
              <dd>{breakdown.noRenewalPeriod}</dd>
            </dl>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="stop-renewals-confirmation" className="text-sm">
              Type <span className="font-mono font-semibold">{CONFIRMATION_PHRASE}</span> to confirm
            </label>
            <Input
              id="stop-renewals-confirmation"
              value={confirmation}
              onChange={e => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canSubmit}
              onClick={() => {
                bulkCancel.mutate({ confirm: CONFIRMATION_PHRASE });
                closeConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Stop renewals
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={result !== null || bulkCancel.isError}
        onOpenChange={nextOpen => {
          if (!nextOpen) {
            setResult(null);
            bulkCancel.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {result
                ? `Stopped renewal for ${result.updated}/${result.total} subscriptions`
                : 'Bulk stop renewal failed'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {result
                ? `Updated ${result.updated}, skipped ${result.skipped}, failed ${result.failed.length}. ${result.noRenewalPeriod.length} updated subscriptions have no renewal period.`
                : bulkCancel.error?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {result && result.failed.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-surface-inset p-3">
              <ul className="space-y-1 font-mono text-xs">
                {result.failed.map(f => (
                  <li key={f.subscriptionId}>
                    <span className="text-muted-foreground">
                      {f.subscriptionId} ({f.userId}):
                    </span>{' '}
                    {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                setResult(null);
                bulkCancel.reset();
              }}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
