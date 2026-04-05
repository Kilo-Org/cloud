'use client';

import { AlertTriangle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBillingDate } from './billing-types';
import type { ClawBillingStatus } from './billing-types';

type CancelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billing: ClawBillingStatus;
};

export function CancelDialog({ open, onOpenChange, billing }: CancelDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const cancelMutation = useMutation(trpc.kiloclaw.cancelSubscription.mutationOptions());

  const isCommit = billing.subscription?.plan === 'commit';
  const periodEnd = billing.subscription?.currentPeriodEnd;

  async function handleConfirm() {
    await cancelMutation.mutateAsync();
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            Cancel Subscription
          </DialogTitle>
          <DialogDescription className="space-y-3 text-left">
            <p>
              Are you sure you want to cancel? You&apos;ll keep access until{' '}
              <strong>
                {periodEnd ? formatBillingDate(periodEnd) : 'the end of your billing period'}
              </strong>
              . After that, your instance will be stopped.
            </p>
            {isCommit && (
              <p className="font-medium text-amber-400">
                Your remaining commit period will not be refunded.
              </p>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep Subscription
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Cancel Subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
