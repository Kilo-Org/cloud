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
  isUnlinking: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function UnlinkAccountDialog({
  open,
  providerName,
  isUnlinking,
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
            to sign in using this method.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isUnlinking}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isUnlinking}>
            {isUnlinking ? 'Unlinking...' : 'Yes, Unlink Account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
