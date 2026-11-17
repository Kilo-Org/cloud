'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import {
  maxSupportDurationMinutes,
  parseSupportDurationMinutes,
} from '@/app/admin/support-access/duration';
import {
  missingSupportRequestRequirements,
  SUPPORT_REASON_MIN_LENGTH,
} from '@/app/admin/support-access/request-requirements';

export type SupportGrantReceipt = {
  id: string;
  organizationId: string;
  actionClass: 'support_read' | 'support_write';
  status: string;
};

export function SupportAccessRequestDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationName: string;
  onGranted?: (grant: SupportGrantReceipt) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [ticketReference, setTicketReference] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('');

  const viewAccessOptions = trpc.admin.supportAccess.viewAccess.queryOptions({ organizationId });

  const request = useMutation(
    trpc.admin.supportAccess.request.mutationOptions({
      onSuccess: grant => {
        toast.success('Read access active');
        void queryClient.invalidateQueries({ queryKey: viewAccessOptions.queryKey });
        setReason('');
        setTicketReference('');
        setDurationMinutes('');
        onOpenChange(false);
        onGranted?.(grant);
      },
      onError: error => toast.error(error.message || 'Failed to request support access'),
    })
  );

  const parsedDuration = parseSupportDurationMinutes(durationMinutes, 'support_read');
  const durationSeconds =
    parsedDuration.valid && parsedDuration.minutes !== undefined
      ? parsedDuration.minutes * 60
      : undefined;
  const missing = missingSupportRequestRequirements({
    organizationId,
    reason,
    durationError: parsedDuration.valid ? undefined : parsedDuration.error,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Request read access to {organizationName}</DialogTitle>
          <DialogDescription>
            You are not a member of this organization. Read access starts immediately for up to{' '}
            {maxSupportDurationMinutes('support_read')} minutes and is recorded. Write access needs
            a second approver on the Support access page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`support-view-reason-${organizationId}`}>
              Reason (at least {SUPPORT_REASON_MIN_LENGTH} characters)
            </Label>
            <Textarea
              id={`support-view-reason-${organizationId}`}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="What are you investigating, and why does it need customer data?"
              rows={3}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`support-view-ticket-${organizationId}`}>
                Ticket reference (optional)
              </Label>
              <Input
                id={`support-view-ticket-${organizationId}`}
                value={ticketReference}
                onChange={event => setTicketReference(event.target.value)}
                placeholder="SUP-1234"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`support-view-duration-${organizationId}`}>
                Duration (minutes, optional)
              </Label>
              <Input
                id={`support-view-duration-${organizationId}`}
                inputMode="numeric"
                aria-invalid={!parsedDuration.valid}
                value={durationMinutes}
                onChange={event => setDurationMinutes(event.target.value)}
                placeholder={String(maxSupportDurationMinutes('support_read'))}
              />
            </div>
          </div>
          {missing.length > 0 && (
            <ul
              id={`support-view-missing-${organizationId}`}
              className="text-muted-foreground list-disc pl-5 text-xs"
            >
              {missing.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            aria-describedby={
              missing.length > 0 ? `support-view-missing-${organizationId}` : undefined
            }
            disabled={request.isPending || missing.length > 0}
            onClick={() =>
              request.mutate({
                organizationId,
                actionClass: 'support_read',
                reason: reason.trim(),
                ticketReference: ticketReference.trim() || undefined,
                durationSeconds,
              })
            }
          >
            Start read access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
