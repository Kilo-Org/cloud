'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getBulkDestroyRetryIds,
  mergeBulkDestroyResults,
  type BulkDestroyResult,
} from './bulk-destroy-results';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
};

export function BulkDestroyDialog({ open, onOpenChange, selectedIds }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<BulkDestroyResult | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [destroyedOpen, setDestroyedOpen] = useState(true);
  const [pendingOpen, setPendingOpen] = useState(true);
  const [skippedOpen, setSkippedOpen] = useState(true);
  const [failedOpen, setFailedOpen] = useState(true);
  const [billingCanceledOpen, setBillingCanceledOpen] = useState(true);
  const [billingNotNeededOpen, setBillingNotNeededOpen] = useState(true);
  const [billingFailedOpen, setBillingFailedOpen] = useState(true);

  const destroyInstances = useMutation(
    trpc.admin.kiloclawInstances.bulkDestroy.mutationOptions({
      onSuccess: (data, variables) => {
        setResult(previous => mergeBulkDestroyResults(previous, data, variables.instanceIds));
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.stats.queryKey(),
        });
        if (data.failed.length === 0 && data.billing.failed.length === 0) {
          if (data.pending.length > 0) {
            toast.info(`Destruction requested; ${data.pending.length} still awaiting cleanup`);
          } else {
            toast.success('Bulk destruction processed');
          }
        } else {
          toast.error(
            `${data.failed.length} destruction failures; ${data.billing.failed.length} hosting cancellation failures`
          );
        }
      },
      onError: error => toast.error(error.message),
    })
  );

  useEffect(() => {
    if (open) {
      setResult(null);
      setConfirmation('');
      setDestroyedOpen(true);
      setPendingOpen(true);
      setSkippedOpen(true);
      setFailedOpen(true);
      setBillingCanceledOpen(true);
      setBillingNotNeededOpen(true);
      setBillingFailedOpen(true);
    }
  }, [open]);

  const retryIds = getBulkDestroyRetryIds(result);
  const submit = (instanceIds: string[]) => {
    if (instanceIds.length === 0 || confirmation !== 'DESTROY') return;
    destroyInstances.mutate({ instanceIds, confirmation: 'DESTROY' });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!destroyInstances.isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {result === null ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Permanently destroy {selectedIds.length}{' '}
                {selectedIds.length === 1 ? 'instance' : 'instances'}?
              </DialogTitle>
              <DialogDescription>
                This runs the same resource and data cleanup as Destroy Instance for every selected
                KiloClaw instance. Associated Stripe and credit-funded hosting subscriptions are
                canceled first. It does not issue refunds or cancel Kilo Pass.
              </DialogDescription>
            </DialogHeader>

            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Destruction cannot be undone</AlertTitle>
              <AlertDescription>
                Instance compute and active storage will be permanently deleted. Billing history and
                retained backups are not erased. If hosting cancellation fails, that instance will
                not be destroyed. Review all results and retry any failures.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <div className="text-sm font-medium">Selected instance IDs</div>
              <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {selectedIds.map(id => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <label htmlFor="bulk-destroy-confirmation" className="text-sm font-medium">
                Type DESTROY to confirm permanent deletion
              </label>
              <Input
                id="bulk-destroy-confirmation"
                value={confirmation}
                onChange={event => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={destroyInstances.isPending}
              />
            </div>

            {destroyInstances.error && (
              <Alert variant="destructive">
                <AlertTitle>Bulk destruction failed</AlertTitle>
                <AlertDescription>
                  {destroyInstances.error instanceof Error
                    ? destroyInstances.error.message
                    : 'The destruction request could not be completed.'}
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={destroyInstances.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => submit(selectedIds)}
                disabled={destroyInstances.isPending || confirmation !== 'DESTROY'}
              >
                {destroyInstances.isPending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Canceling hosting and destroying...
                  </>
                ) : (
                  `Destroy ${selectedIds.length} ${selectedIds.length === 1 ? 'instance' : 'instances'} and cancel hosting`
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Bulk destruction results</DialogTitle>
              <DialogDescription>
                Instances: destroyed {result.destroyed.length}, pending {result.pending.length},
                skipped {result.skipped.length}, failed {result.failed.length}.
                <br />
                Hosting: canceled for {result.billing.canceled.length}, no cancellation needed for{' '}
                {result.billing.notNeeded.length}, failed for {result.billing.failed.length}.
              </DialogDescription>
            </DialogHeader>

            {result.pending.length > 0 && (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertTitle>Background cleanup pending</AlertTitle>
                <AlertDescription>
                  Deletion has been requested but provider cleanup has not finished. The worker
                  retries pending cleanup automatically. Check these instances again before treating
                  their deletion as complete.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-3 py-2">
              <ResultSection
                title="Instances destroyed"
                ids={result.destroyed}
                open={destroyedOpen}
                onToggle={() => setDestroyedOpen(value => !value)}
                className="border-green-500/30 bg-green-500/5"
              />
              <ResultSection
                title="Provider cleanup pending"
                ids={result.pending}
                open={pendingOpen}
                onToggle={() => setPendingOpen(value => !value)}
                className="border-amber-500/30 bg-amber-500/5"
              />
              <ResultSection
                title="Destruction skipped"
                ids={result.skipped.map(item => `${item.instanceId}\t${item.reason}`)}
                open={skippedOpen}
                onToggle={() => setSkippedOpen(value => !value)}
                className="border-amber-500/30 bg-amber-500/5"
              />
              <ResultSection
                title="Destruction failures"
                ids={result.failed.map(item => `${item.instanceId}\t${item.error}`)}
                open={failedOpen}
                onToggle={() => setFailedOpen(value => !value)}
                className="border-destructive/40 bg-destructive/5"
              />
              <ResultSection
                title="Hosting canceled"
                ids={result.billing.canceled.map(
                  item => `${item.instanceId}\t${item.subscriptionIds.join(', ')}`
                )}
                open={billingCanceledOpen}
                onToggle={() => setBillingCanceledOpen(value => !value)}
                className="border-green-500/30 bg-green-500/5"
              />
              <ResultSection
                title="No cancellation needed"
                ids={result.billing.notNeeded}
                open={billingNotNeededOpen}
                onToggle={() => setBillingNotNeededOpen(value => !value)}
                className="border-muted-foreground/30 bg-muted/30"
              />
              <ResultSection
                title="Hosting cancellation failures"
                ids={result.billing.failed.map(item => `${item.instanceId}\t${item.error}`)}
                open={billingFailedOpen}
                onToggle={() => setBillingFailedOpen(value => !value)}
                className="border-destructive/40 bg-destructive/5"
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={destroyInstances.isPending}
              >
                Done
              </Button>
              {retryIds.length > 0 && (
                <Button
                  variant="destructive"
                  onClick={() => submit(retryIds)}
                  disabled={destroyInstances.isPending}
                >
                  {destroyInstances.isPending
                    ? 'Checking and retrying...'
                    : `Check / retry ${retryIds.length} remaining`}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultSection({
  title,
  ids,
  open,
  onToggle,
  className,
}: {
  title: string;
  ids: string[];
  open: boolean;
  onToggle: () => void;
  className: string;
}) {
  if (ids.length === 0) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ids.join('\n'));
      toast.success(`Copied ${title.toLowerCase()} results`);
    } catch {
      toast.error('Could not copy results');
    }
  };

  return (
    <div className={`rounded-md border p-3 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-1 text-sm font-medium"
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {title} ({ids.length})
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy()}
          aria-label={`Copy ${title.toLowerCase()} results`}
        >
          <Copy className="size-3" />
        </Button>
      </div>
      {open && (
        <ul className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs">
          {ids.map(id => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
