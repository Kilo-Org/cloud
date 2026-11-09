'use client';

import { useState, type ReactNode } from 'react';
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
import { maxSupportDurationMinutes, parseSupportDurationMinutes } from './duration';
import {
  missingSupportRequestRequirements,
  SUPPORT_REASON_MIN_LENGTH,
} from './request-requirements';

function openOrganization(href: string): boolean {
  const opened = window.open(href, '_blank');
  if (!opened) return false;
  opened.opener = null;
  return true;
}

export function AdminViewOrganizationButton({
  organizationId,
  organizationName,
  className,
  children,
}: {
  organizationId: string;
  organizationName: string;
  className?: string;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const href = `/organizations/${organizationId}`;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readyToOpen, setReadyToOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ticketReference, setTicketReference] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('');

  const viewAccessOptions = trpc.admin.supportAccess.viewAccess.queryOptions({ organizationId });

  const request = useMutation(
    trpc.admin.supportAccess.request.mutationOptions({
      onSuccess: () => {
        toast.success('Read access active');
        void queryClient.invalidateQueries({ queryKey: viewAccessOptions.queryKey });
        setReason('');
        setTicketReference('');
        setDurationMinutes('');
        if (openOrganization(href)) {
          setOpen(false);
        } else {
          setReadyToOpen(true);
        }
      },
      onError: error => toast.error(error.message || 'Failed to request support access'),
    })
  );

  const handleClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setChecking(true);
    try {
      const access = await queryClient.fetchQuery({ ...viewAccessOptions, staleTime: 0 });
      if (!access.grantRequired) {
        if (!openOrganization(href)) {
          setReadyToOpen(true);
          setOpen(true);
        }
        return;
      }
      setReadyToOpen(false);
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check organization access');
    } finally {
      setChecking(false);
    }
  };

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
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        aria-busy={checking}
        onClick={handleClick}
      >
        {children}
      </a>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClick={event => event.stopPropagation()}>
          {readyToOpen ? (
            <>
              <DialogHeader>
                <DialogTitle>Open {organizationName}</DialogTitle>
                <DialogDescription>
                  Your browser blocked the new tab. Open the organization from here.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button asChild>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpen(false)}
                  >
                    Open organization
                  </a>
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Request read access to {organizationName}</DialogTitle>
                <DialogDescription>
                  You are not a member of this organization. Read access starts immediately for up
                  to {maxSupportDurationMinutes('support_read')} minutes and is recorded. Write
                  access needs a second approver on the Support access page.
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
                <Button variant="outline" onClick={() => setOpen(false)}>
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
                  Start read access and open
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
