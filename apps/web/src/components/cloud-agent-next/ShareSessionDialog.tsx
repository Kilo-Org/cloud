'use client';

import type { ComponentProps } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SessionSharePanel } from './SessionSharePanel';

type ShareSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  kiloSessionId?: string;
};

export function ShareSessionDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  kiloSessionId,
}: ShareSessionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Share Session</DialogTitle>
          <DialogDescription>
            Choose how long the link works and whether it includes new messages.
          </DialogDescription>
        </DialogHeader>
        <SessionSharePanel kiloSessionId={kiloSessionId} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
