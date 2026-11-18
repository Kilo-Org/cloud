'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type InvokeTriggerDialogProps = {
  open: boolean;
  triggerId: string | null;
  isInvokable: boolean;
  isInvoking: boolean;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
};

export const InvokeTriggerDialog = memo(function InvokeTriggerDialog({
  open,
  triggerId,
  isInvokable,
  isInvoking,
  onClose,
  onConfirm,
}: InvokeTriggerDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmationInFlightRef = useRef(false);
  const isPending = isConfirming || isInvoking;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !isPending) onClose();
    },
    [isPending, onClose]
  );

  const handleConfirm = useCallback(async () => {
    if (!isInvokable || isPending || confirmationInFlightRef.current) return;

    confirmationInFlightRef.current = true;
    setIsConfirming(true);
    try {
      if (await onConfirm()) onClose();
    } catch {
      return;
    } finally {
      confirmationInFlightRef.current = false;
      setIsConfirming(false);
    }
  }, [isInvokable, isPending, onClose, onConfirm]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isPending}
        onEscapeKeyDown={event => {
          if (isPending) event.preventDefault();
        }}
        onPointerDownOutside={event => {
          if (isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Invoke trigger now?</DialogTitle>
          <DialogDescription>
            Invoke the scheduled trigger &quot;{triggerId}&quot; using its saved configuration. This
            starts a new run now; its recurring schedule remains unchanged and compute charges may
            apply.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!isInvokable || isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Invoking...
              </>
            ) : (
              'Invoke now'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
