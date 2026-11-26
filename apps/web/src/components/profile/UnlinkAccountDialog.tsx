'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type UnlinkAccountDialogProps = {
  open: boolean;
  providerName: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function UnlinkAccountDialog({
  open,
  providerName,
  onConfirm,
  onCancel,
}: UnlinkAccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onCancel}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5" />
            <DialogTitle>Confirm Account Unlinking</DialogTitle>
          </div>
          <DialogDescription>
            Are you sure you want to unlink your {providerName} account? You will no longer be able
            to sign in using this method. We will email you a code to confirm the change.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Yes, Unlink Account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
