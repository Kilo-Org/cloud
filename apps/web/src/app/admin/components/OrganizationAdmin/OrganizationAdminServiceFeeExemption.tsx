'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminOrganizationServiceFeeExemption,
  useSetOrganizationServiceFeeExemption,
} from '@/app/admin/api/organizations/hooks';
import { Receipt } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  canSubmitServiceFeeExemption,
  resolveServiceFeeExemptionDialogOpenChange,
  SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH,
  SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH,
  shouldBlockServiceFeeExemptionDialogDismiss,
} from './OrganizationAdminServiceFeeExemption.dialog-state';

function formatLocalTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function ExemptionStateBadge({ isExempt }: { isExempt: boolean }) {
  return (
    <Badge variant={isExempt ? 'new' : 'secondary-outline'}>
      {isExempt ? 'Exempt' : 'Fees apply'}
    </Badge>
  );
}

export function OrganizationAdminServiceFeeExemption({
  organizationId,
}: {
  organizationId: string;
}) {
  const exemptionQuery = useAdminOrganizationServiceFeeExemption(organizationId);
  const setExemptionMutation = useSetOrganizationServiceFeeExemption();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (exemptionQuery.isPending) {
    return <Skeleton className="h-44 w-full rounded-xl" />;
  }

  if (exemptionQuery.isError) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Service fee exemption</CardTitle>
          <CardDescription>Unable to load the organization service fee exemption.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void exemptionQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { current, history } = exemptionQuery.data;
  const isExempt = current?.isExempt ?? false;
  const actionLabel = isExempt ? 'Revoke exemption' : 'Grant exemption';
  const pendingLabel = isExempt ? 'Revoking exemption…' : 'Granting exemption…';
  const isMutationPending = setExemptionMutation.isPending;
  const trimmedReasonLength = reason.trim().length;
  const canSubmit = canSubmitServiceFeeExemption({ trimmedReasonLength, isMutationPending });
  const blockDismiss = shouldBlockServiceFeeExemptionDialogDismiss({ isMutationPending });

  const handleConfirm = () => {
    if (!canSubmit) return;

    setExemptionMutation.mutate(
      {
        organizationId,
        isExempt: !isExempt,
        reason,
      },
      {
        onSuccess: () => {
          toast.success(
            isExempt ? 'Service fee exemption revoked' : 'Service fee exemption granted'
          );
          setReason('');
          setIsDialogOpen(false);
        },
        // On error the dialog stays open and the reason is kept so the admin
        // can retry without retyping.
      }
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Receipt className="size-4" aria-hidden />
              Service fee exemption
            </CardTitle>
            <CardDescription>
              Waive Stripe service fees on this organization&apos;s new purchases. Exemptions are
              not inherited by parent or child organizations.
            </CardDescription>
          </div>
          <ExemptionStateBadge isExempt={isExempt} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {current ? (
          <div className="space-y-1 rounded-lg border p-3">
            <p className="type-label text-muted-foreground">Current reason</p>
            <p className="type-body break-words whitespace-pre-wrap">{current.reason}</p>
            <p className="text-muted-foreground text-xs">
              By{' '}
              <span className="font-mono break-all">
                {current.changedByKiloUserId ?? 'Deleted admin'}
              </span>{' '}
              on {formatLocalTimestamp(current.changedAt)}
            </p>
          </div>
        ) : null}

        <Dialog
          open={isDialogOpen}
          onOpenChange={requestedOpen => {
            // While the mutation is in flight every close/reopen request
            // (Cancel, close button, Escape, overlay) is ignored so the
            // dialog cannot be dismissed, reset, or reopened mid-request.
            const next = resolveServiceFeeExemptionDialogOpenChange({
              requestedOpen,
              isMutationPending,
            });
            if (!next) return;
            if (next.resetMutation) {
              setExemptionMutation.reset();
            }
            setIsDialogOpen(next.open);
          }}
        >
          <DialogTrigger asChild>
            <Button
              variant={isExempt ? 'outline' : 'default'}
              size="sm"
              className="w-full sm:w-auto"
            >
              {actionLabel}
            </Button>
          </DialogTrigger>
          <DialogContent
            // onOpenChange fires after Radix's own handlers, so Escape and
            // overlay clicks must be prevented at the content level, and the
            // close button is hidden, while the mutation is pending.
            showCloseButton={!isMutationPending}
            aria-busy={isMutationPending}
            onEscapeKeyDown={event => {
              if (blockDismiss) event.preventDefault();
            }}
            onPointerDownOutside={event => {
              if (blockDismiss) event.preventDefault();
            }}
            onInteractOutside={event => {
              if (blockDismiss) event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {isExempt ? 'Revoke service fee exemption' : 'Grant service fee exemption'}
              </DialogTitle>
              <DialogDescription>
                {isExempt
                  ? 'Stripe service fees apply to this organization’s new purchases again.'
                  : 'New purchases by this organization skip the Stripe service fee.'}{' '}
                The reason is recorded in the admin-only exemption history.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label htmlFor="service-fee-exemption-reason">Reason (required)</Label>
              <Textarea
                id="service-fee-exemption-reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
                minLength={SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH}
                maxLength={SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH}
                rows={3}
                required
                disabled={isMutationPending}
                aria-describedby={
                  setExemptionMutation.isError
                    ? 'service-fee-exemption-reason-hint service-fee-exemption-error'
                    : 'service-fee-exemption-reason-hint'
                }
                className="break-words"
              />
              <p id="service-fee-exemption-reason-hint" className="text-muted-foreground text-xs">
                {SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH} to{' '}
                {SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH} characters. Visible to platform admins
                only.
              </p>
              {setExemptionMutation.isError ? (
                <p
                  id="service-fee-exemption-error"
                  role="alert"
                  className="text-status-destructive text-sm"
                >
                  {setExemptionMutation.error.message}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                disabled={isMutationPending}
              >
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={!canSubmit}>
                {isMutationPending ? pendingLabel : actionLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="space-y-2 border-t pt-4">
          <p className="type-label text-muted-foreground">History</p>
          {history.length === 0 ? (
            <p className="text-muted-foreground type-body">No exemption changes yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map(entry => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ExemptionStateBadge isExempt={entry.isExempt} />
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatLocalTimestamp(entry.createdAt)}
                      </span>
                    </div>
                    <p className="type-body break-words whitespace-pre-wrap">{entry.reason}</p>
                    <p className="text-muted-foreground font-mono text-xs break-all">
                      {entry.changedByKiloUserId ?? 'Deleted admin'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
