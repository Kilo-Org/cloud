'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioButtonGroup } from '@/components/ui/RadioGroup';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDate } from '@/lib/admin-utils';
import { toast } from 'sonner';

const DEFAULT_TRIAL_DAYS = 7;

function formatDateOrDash(date: string | null | undefined): string {
  return date ? formatDate(date) : '—';
}

function toLocalDateInputValue(date: string): string {
  const parsed = new Date(date);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateInputToEndOfDayIso(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 0).toISOString();
}

function getAccessBadgeClass(hasAccess: boolean) {
  return hasAccess ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400';
}

function getSubscriptionStatusBadgeClass(status: string) {
  switch (status) {
    case 'active':
      return 'bg-green-900/20 text-green-400';
    case 'trialing':
      return 'bg-blue-900/20 text-blue-400';
    case 'past_due':
    case 'unpaid':
      return 'bg-yellow-900/20 text-yellow-400';
    case 'canceled':
      return 'bg-red-900/20 text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

const CANCEL_MODES = ['period_end', 'immediate'] as const;
type CancelMode = (typeof CANCEL_MODES)[number];
function isCancelMode(value: string): value is CancelMode {
  return (CANCEL_MODES as readonly string[]).includes(value);
}

export function UserAdminKiloClaw({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Trial edit dialog
  const [trialDialogOpen, setTrialDialogOpen] = useState(false);
  const [trialSubscriptionId, setTrialSubscriptionId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState('');

  // Cancel dialog
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelSubscriptionId, setCancelSubscriptionId] = useState<string | null>(null);
  const [cancelMode, setCancelMode] = useState<CancelMode>('period_end');

  // Hide inactive toggle
  const [hideInactive, setHideInactive] = useState(true);

  const { data, isLoading, error } = useQuery(
    trpc.admin.users.getKiloClawState.queryOptions({ userId })
  );

  const trialSubscription = data?.subscriptions?.find(s => s.id === trialSubscriptionId);

  useEffect(() => {
    if (!trialDialogOpen) return;

    const currentTrialEndAt = trialSubscription?.trial_ends_at;
    if (currentTrialEndAt && trialSubscription?.status !== 'canceled') {
      setSelectedDate(toLocalDateInputValue(currentTrialEndAt));
    } else {
      const defaultTrialEnd = new Date();
      defaultTrialEnd.setDate(defaultTrialEnd.getDate() + DEFAULT_TRIAL_DAYS);
      setSelectedDate(toLocalDateInputValue(defaultTrialEnd.toISOString()));
    }
  }, [trialSubscription?.trial_ends_at, trialSubscription?.status, trialDialogOpen]);

  const updateTrialEndAt = useMutation(
    trpc.admin.users.updateKiloClawTrialEndAt.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
        setTrialDialogOpen(false);
        toast.success('KiloClaw trial end date updated');
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to update KiloClaw trial end date');
      },
    })
  );

  const cancelSubscription = useMutation(
    trpc.admin.users.cancelKiloClawSubscription.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
        setCancelDialogOpen(false);
        toast.success(
          cancelMode === 'immediate'
            ? 'KiloClaw subscription canceled immediately'
            : 'KiloClaw subscription set to cancel at period end'
        );
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to cancel KiloClaw subscription');
      },
    })
  );

  const handleTrialSave = () => {
    if (!selectedDate || !trialSubscriptionId) {
      toast.error('Select a trial end date');
      return;
    }
    const trialEndsAt = localDateInputToEndOfDayIso(selectedDate);
    updateTrialEndAt.mutate({
      userId,
      subscriptionId: trialSubscriptionId,
      trial_ends_at: trialEndsAt,
    });
  };

  const handleCancelConfirm = () => {
    if (!cancelSubscriptionId) return;
    cancelSubscription.mutate({
      userId,
      subscriptionId: cancelSubscriptionId,
      mode: cancelMode,
    });
  };

  const openTrialDialog = (subscriptionId: string) => {
    setTrialSubscriptionId(subscriptionId);
    setTrialDialogOpen(true);
  };

  const openCancelDialog = (subscriptionId: string, status: string) => {
    setCancelSubscriptionId(subscriptionId);
    setCancelMode(status === 'past_due' ? 'immediate' : 'period_end');
    setCancelDialogOpen(true);
  };

  if (isLoading) {
    return (
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>KiloClaw</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>KiloClaw</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-400">Failed to load KiloClaw state</p>
        </CardContent>
      </Card>
    );
  }

  const subscriptions = data?.subscriptions ?? [];
  const visibleSubscriptions = hideInactive
    ? subscriptions.filter(s => s.status !== 'canceled')
    : subscriptions;
  const hiddenCount = subscriptions.length - visibleSubscriptions.length;

  const cancelingSubscription = subscriptions.find(s => s.id === cancelSubscriptionId);

  return (
    <>
      <Card className="lg:col-span-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>KiloClaw</CardTitle>
              <CardDescription>
                {subscriptions.length === 0
                  ? 'No subscriptions'
                  : `${subscriptions.length} subscription${subscriptions.length !== 1 ? 's' : ''}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {data?.activeInstanceId && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/admin/kiloclaw/${data.activeInstanceId}`}>
                    <ExternalLink className="mr-1 h-3 w-3" />
                    View Instance
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Access & earlybird summary */}
          <div className="flex items-center gap-4">
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Access</h4>
              <Badge className={getAccessBadgeClass(data?.hasAccess ?? false)}>
                {data?.hasAccess ? 'has access' : 'no access'}
              </Badge>
              {data?.accessReason ? (
                <p className="text-muted-foreground mt-1 text-xs">{data.accessReason}</p>
              ) : null}
            </div>

            {data?.earlybird ? (
              <div className="rounded-lg border p-3">
                <h4 className="mb-1 text-sm font-medium">Earlybird</h4>
                <div className="flex gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Expires</span>
                    <p>{formatDate(data.earlybird.expiresAt)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Days remaining</span>
                    <p>{data.earlybird.daysRemaining}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Hide inactive toggle */}
          {subscriptions.some(s => s.status === 'canceled') && (
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={hideInactive}
                  onChange={e => setHideInactive(e.target.checked)}
                  className="rounded"
                />
                Hide inactive subscriptions
                {hiddenCount > 0 && (
                  <span className="text-muted-foreground">({hiddenCount} hidden)</span>
                )}
              </label>
            </div>
          )}

          {/* Subscription list */}
          {visibleSubscriptions.length === 0 && subscriptions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This user does not have any KiloClaw subscription rows.
            </p>
          ) : visibleSubscriptions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              All subscriptions are inactive. Uncheck &quot;Hide inactive subscriptions&quot; to
              view them.
            </p>
          ) : (
            <div className="space-y-4">
              {visibleSubscriptions.map(sub => {
                const isEffective = sub.id === data?.effectiveSubscriptionId;
                const canEditTrialEnd = sub.status === 'trialing' || sub.status === 'canceled';
                const isTrialReset = sub.status === 'canceled';
                const canCancel =
                  (sub.status === 'active' || sub.status === 'past_due') &&
                  sub.plan !== 'trial' &&
                  !sub.cancel_at_period_end;
                const canImmediateCancel =
                  (sub.status === 'active' || sub.status === 'past_due') && sub.plan !== 'trial';

                return (
                  <div
                    key={sub.id}
                    className={`rounded-lg border p-4 ${isEffective ? 'border-blue-500/40 bg-blue-950/10' : ''}`}
                  >
                    {/* Header row */}
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge className={getSubscriptionStatusBadgeClass(sub.status)}>
                          {sub.status}
                        </Badge>
                        <span className="text-sm font-semibold">{sub.plan}</span>
                        {isEffective && (
                          <Badge variant="outline" className="text-xs">
                            effective
                          </Badge>
                        )}
                        {sub.cancel_at_period_end && (
                          <Badge className="bg-orange-900/20 text-orange-400">
                            cancels at period end
                          </Badge>
                        )}
                        {sub.pending_conversion && (
                          <Badge className="bg-purple-900/20 text-purple-400">
                            pending conversion
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {sub.instance && (
                          <Button variant="outline" size="sm" asChild>
                            <Link href={`/admin/kiloclaw/${sub.instance.id}`}>
                              <ExternalLink className="mr-1 h-3 w-3" />
                              {sub.instance.name ?? 'Instance'}
                            </Link>
                          </Button>
                        )}
                        {canEditTrialEnd && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openTrialDialog(sub.id)}
                          >
                            {isTrialReset ? 'Reset Trial' : 'Edit Trial End'}
                          </Button>
                        )}
                        {canCancel && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 text-red-400 hover:bg-red-950/30"
                            onClick={() => openCancelDialog(sub.id, sub.status)}
                          >
                            Cancel
                          </Button>
                        )}
                        {!canCancel && canImmediateCancel && sub.cancel_at_period_end && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 text-red-400 hover:bg-red-950/30"
                            onClick={() => openCancelDialog(sub.id, sub.status)}
                          >
                            Cancel Immediately
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Detail grid */}
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <Field label="Payment Source" value={sub.payment_source ?? '—'} />
                      <Field
                        label="Stripe Subscription"
                        value={sub.stripe_subscription_id ?? '—'}
                        mono
                      />
                      <Field label="Instance ID" value={sub.instance_id ?? '—'} mono />
                      <Field
                        label="Instance"
                        value={
                          sub.instance
                            ? `${sub.instance.name ?? sub.instance.sandbox_id}${sub.instance.destroyed_at ? ' (destroyed)' : ''}`
                            : '—'
                        }
                      />
                      <Field label="Trial Started" value={formatDateOrDash(sub.trial_started_at)} />
                      <Field label="Trial Ends" value={formatDateOrDash(sub.trial_ends_at)} />
                      <Field
                        label="Period Start"
                        value={formatDateOrDash(sub.current_period_start)}
                      />
                      <Field label="Period End" value={formatDateOrDash(sub.current_period_end)} />
                      <Field label="Commit Ends" value={formatDateOrDash(sub.commit_ends_at)} />
                      <Field
                        label="Credit Renewal"
                        value={formatDateOrDash(sub.credit_renewal_at)}
                      />
                      <Field label="Scheduled Plan" value={sub.scheduled_plan ?? '—'} />
                      <Field label="Scheduled By" value={sub.scheduled_by ?? '—'} />
                      <Field label="Stripe Schedule" value={sub.stripe_schedule_id ?? '—'} mono />
                      <Field label="Suspended At" value={formatDateOrDash(sub.suspended_at)} />
                      <Field
                        label="Destruction Deadline"
                        value={formatDateOrDash(sub.destruction_deadline)}
                      />
                      <Field label="Past Due Since" value={formatDateOrDash(sub.past_due_since)} />
                      <Field label="Created" value={formatDate(sub.created_at)} />
                      <Field label="Updated" value={formatDate(sub.updated_at)} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trial edit dialog */}
      <Dialog open={trialDialogOpen} onOpenChange={setTrialDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {trialSubscription?.status === 'canceled'
                ? 'Reset KiloClaw Trial'
                : 'Edit KiloClaw Trial End Date'}
            </DialogTitle>
            <DialogDescription>
              {trialSubscription?.status === 'canceled'
                ? 'Reset this canceled subscription to a new trial. This will restore access, clear suspension state, and attempt to restart the instance.'
                : "Set the day this user's KiloClaw trial ends. The trial will end at the end of the selected day."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="kiloclaw-trial-end-date">Trial End Date</Label>
            <Input
              id="kiloclaw-trial-end-date"
              type="date"
              value={selectedDate}
              onChange={event => setSelectedDate(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTrialDialogOpen(false)}
              disabled={updateTrialEndAt.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleTrialSave}
              disabled={updateTrialEndAt.isPending || !selectedDate}
            >
              {updateTrialEndAt.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel subscription dialog */}
      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel KiloClaw Subscription</DialogTitle>
            <DialogDescription>
              This will cancel the subscription for this user. No refund will be issued.
              {cancelingSubscription?.stripe_subscription_id
                ? ' This is a Stripe-funded subscription — Stripe will be updated.'
                : ' This is a credit-funded subscription — only the local database will be updated.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label>Cancellation timing</Label>
            {cancelingSubscription?.status === 'past_due' ? (
              <p className="text-muted-foreground text-xs">
                Past-due subscriptions can only be canceled immediately. No refund. Local access
                ends now. The lifecycle will suspend/stop the instance on its next run.
              </p>
            ) : (
              <>
                <RadioButtonGroup
                  options={[
                    { value: 'period_end', label: 'At period end' },
                    { value: 'immediate', label: 'Immediately' },
                  ]}
                  value={cancelMode}
                  onChange={v => {
                    if (isCancelMode(v)) setCancelMode(v);
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  {cancelMode === 'period_end'
                    ? 'No refund. The user keeps access until the current billing period ends.'
                    : 'No refund. Local access ends now. The lifecycle will suspend/stop the instance on its next run.'}
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelDialogOpen(false)}
              disabled={cancelSubscription.isPending}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelConfirm}
              disabled={cancelSubscription.isPending}
            >
              {cancelSubscription.isPending
                ? 'Canceling...'
                : cancelMode === 'immediate'
                  ? 'Cancel Immediately'
                  : 'Cancel at Period End'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <h4 className="text-muted-foreground text-xs font-medium">{label}</h4>
      <p className={`text-sm ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
