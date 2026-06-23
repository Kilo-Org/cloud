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
import { securityAgentCommandAdmissionCopy } from './security-agent-command-copy';
import {
  DISMISS_REASONS,
  getDismissFindingFormDefaults,
  MAX_DISMISS_COMMENT_LENGTH,
  type DismissReason,
} from './dismiss-finding-form';

const DISMISS_REASON_VALUES = new Set<string>(DISMISS_REASONS.map(reason => reason.value));

function isDismissReason(value: string): value is DismissReason {
  return DISMISS_REASON_VALUES.has(value);
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
  const formDefaults = getDismissFindingFormDefaults(finding?.analysis);
  const [reason, setReason] = useState<DismissReason>(formDefaults.reason);
  const [comment, setComment] = useState(formDefaults.comment);

  const handleSubmit = () => {
    onDismiss(reason, comment || undefined);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setReason(formDefaults.reason);
      setComment(formDefaults.comment);
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
            Dismiss finding
          </DialogTitle>
          <DialogDescription>
            This will dismiss the Dependabot alert on GitHub. Choose a reason for dismissing this
            vulnerability.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Finding Summary */}
          <div className="bg-muted/50 border-border rounded-lg border p-3">
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
              placeholder="Add context for this dismissal"
              value={comment}
              onChange={e => setComment(e.target.value)}
              maxLength={MAX_DISMISS_COMMENT_LENGTH}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
            Keep finding
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={isLoading}>
            {isLoading
              ? `${securityAgentCommandAdmissionCopy.dismiss_finding.pendingLabel}...`
              : 'Dismiss finding'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { DismissReason };
