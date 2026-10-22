'use client';

import { useState, type ComponentProps } from 'react';
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
  const [isSharing, setIsSharing] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!isSharing) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!isSharing}
      >
        <DialogHeader>
          <DialogTitle>Share Session</DialogTitle>
          <DialogDescription>
            Choose how long the link works and whether it includes new messages.
          </DialogDescription>
        </DialogHeader>
        <SessionSharePanel
          kiloSessionId={kiloSessionId}
          isSharing={isSharing}
          onSharingChange={setIsSharing}
        />
        <DialogFooter>
          <Button variant="outline" disabled={isSharing} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
