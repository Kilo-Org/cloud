'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { AlertTriangle } from 'lucide-react';
import type { SecurityFinding } from '@kilocode/db/schema';

// GitHub Dependabot dismiss reasons
const DISMISS_REASONS = [
  {
    value: 'fix_started',
    label: 'Fix started',
    description: 'A fix for this vulnerability has been started',
  },
  {
    value: 'no_bandwidth',
    label: 'No bandwidth',
    description: 'No bandwidth to fix this vulnerability at this time',
  },
  {
    value: 'tolerable_risk',
    label: 'Tolerable risk',
    description: 'The risk is tolerable for this project',
  },
  {
    value: 'inaccurate',
    label: 'Inaccurate',
    description: 'This alert is inaccurate or incorrect',
  },
  {
    value: 'not_used',
    label: 'Not used',
    description: 'This vulnerable code is not actually used',
  },
] as const;

type DismissReason = (typeof DISMISS_REASONS)[number]['value'];

const DISMISS_REASON_VALUES = DISMISS_REASONS.map(r => r.value);

function isDismissReason(value: string): value is DismissReason {
  return DISMISS_REASON_VALUES.includes(value as DismissReason);
}

type DismissFindingDialogProps = {
  finding: SecurityFinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (reason: DismissReason, comment?: string) => void;
  isLoading: boolean;
};

export function DismissFindingDialog({
  finding,
  open,
  onOpenChange,
  onDismiss,
  isLoading,
}: DismissFindingDialogProps) {
  const [reason, setReason] = useState<DismissReason>('not_used');
  const [comment, setComment] = useState('');

  const handleSubmit = () => {
    onDismiss(reason, comment || undefined);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setReason('not_used');
      setComment('');
    }
    onOpenChange(newOpen);
  };

  if (!finding) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Dismiss Finding
          </DialogTitle>
          <DialogDescription>
            This will dismiss the Dependabot alert on GitHub. Choose a reason for dismissing this
            vulnerability.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Finding Summary */}
          <div className="bg-muted/50 rounded-lg border p-3">
            <p className="text-sm font-medium">{finding.title}</p>
            <p className="text-muted-foreground text-xs">
              {finding.package_name} • {finding.severity}
            </p>
          </div>

          {/* Reason Selection */}
          <div className="space-y-3">
            <Label>Reason for dismissal</Label>
            <RadioGroup
              value={reason}
              onValueChange={value => {
                if (isDismissReason(value)) {
                  setReason(value);
                }
              }}
              className="space-y-2"
            >
              {DISMISS_REASONS.map(r => (
                <div key={r.value} className="flex items-start space-x-3">
                  <RadioGroupItem value={r.value} id={r.value} className="mt-1" />
                  <div className="flex-1">
                    <Label htmlFor={r.value} className="cursor-pointer font-medium">
                      {r.label}
                    </Label>
                    <p className="text-muted-foreground text-xs">{r.description}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Optional Comment */}
          <div className="space-y-2">
            <Label htmlFor="comment">Comment (optional)</Label>
            <Textarea
              id="comment"
              placeholder="Add additional context for this dismissal..."
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Dismissing...' : 'Dismiss Alert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { DismissReason };
