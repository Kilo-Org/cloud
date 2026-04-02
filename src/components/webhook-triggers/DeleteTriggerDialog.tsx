'use client';

import { memo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

export type DeleteTarget = {
  triggerId: string;
  githubRepo: string;
};

type DeleteTriggerDialogProps = {
  open: boolean;
  trigger: DeleteTarget | null;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
};

/**
 * Confirmation dialog for deleting a webhook trigger.
 */
export const DeleteTriggerDialog = memo(function DeleteTriggerDialog({
  open,
  trigger,
  onClose,
  onConfirm,
  isDeleting,
}: DeleteTriggerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Trigger</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the trigger &quot;{trigger?.triggerId}&quot;
            {trigger?.githubRepo && <> for repository &quot;{trigger.githubRepo}&quot;</>}? This
            action cannot be undone. Any pending webhook requests will fail.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
