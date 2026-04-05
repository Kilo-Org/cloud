'use client';

import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

export function KiloPassCancellationFeedbackModal(props: {
  isOpen: boolean;
  onClose: () => void;
  isCanceling: boolean;
  reasons: readonly string[];
  selectedReasons: readonly string[];
  onToggleReason: (reason: string) => void;
  freeformText: string;
  onChangeFreeformText: (next: string) => void;
  onKeepSubscription: () => void;
  onCancelSubscription: () => void;
}) {
  const {
    isOpen,
    onClose,
    isCanceling,
    reasons,
    selectedReasons,
    onToggleReason,
    freeformText,
    onChangeFreeformText,
    onKeepSubscription,
    onCancelSubscription,
  } = props;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Feedback</DialogTitle>
          <DialogDescription>
            Help us improve by sharing why you&apos;re cancelling your subscription
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-2">
            <div className="text-sm font-medium">Reasons (optional)</div>
            <div className="flex flex-wrap gap-2">
              {reasons.map(reason => {
                const isSelected = selectedReasons.includes(reason);
                return (
                  <Button
                    key={reason}
                    type="button"
                    variant={isSelected ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => onToggleReason(reason)}
                    disabled={isCanceling}
                    className="h-8 min-w-56 justify-start"
                  >
                    {isSelected ? <Check className="h-4 w-4 text-emerald-400" /> : null}
                    <span className={isSelected ? '' : 'pl-6'}>{reason}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-2">
            <div className="text-sm font-medium">What can we improve on?</div>
            <Textarea
              placeholder="(Optional)"
              value={freeformText}
              onChange={e => onChangeFreeformText(e.target.value)}
              disabled={isCanceling}
            />
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onKeepSubscription} disabled={isCanceling}>
            Keep subscription
          </Button>
          <Button variant="destructive" onClick={onCancelSubscription} disabled={isCanceling}>
            {isCanceling ? 'Canceling...' : 'Cancel subscription'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
