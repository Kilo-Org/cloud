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
import { useTRPC } from '@/lib/trpc/utils';
import { formatDate } from '@/lib/admin-utils';
import { toast } from 'sonner';

const DEFAULT_TRIAL_DAYS = 7;

function formatDateOrDash(date: string | null): string {
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

export function UserAdminKiloClaw({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');

  const { data, isLoading, error } = useQuery(
    trpc.admin.users.getKiloClawState.queryOptions({ userId })
  );

  useEffect(() => {
    if (!dialogOpen) return;

    const currentTrialEndAt = data?.subscription?.trial_ends_at;
    if (currentTrialEndAt && data?.subscription?.status !== 'canceled') {
      setSelectedDate(toLocalDateInputValue(currentTrialEndAt));
    } else {
      const defaultTrialEnd = new Date();
      defaultTrialEnd.setDate(defaultTrialEnd.getDate() + DEFAULT_TRIAL_DAYS);
      setSelectedDate(toLocalDateInputValue(defaultTrialEnd.toISOString()));
    }
  }, [data?.subscription?.trial_ends_at, data?.subscription?.status, dialogOpen]);

  const updateTrialEndAt = useMutation(
    trpc.admin.users.updateKiloClawTrialEndAt.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.users.getKiloClawState.queryKey({ userId }),
        });
        setDialogOpen(false);
        toast.success('KiloClaw trial end date updated');
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to update KiloClaw trial end date');
      },
    })
  );

  const handleSave = () => {
    if (!selectedDate) {
      toast.error('Select a trial end date');
      return;
    }

    const trialEndsAt = localDateInputToEndOfDayIso(selectedDate);
    updateTrialEndAt.mutate({
      userId,
      trial_ends_at: trialEndsAt,
    });
  };

  if (isLoading) {
    return (
      <Card className="lg:col-span-2">
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
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>KiloClaw</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-400">Failed to load KiloClaw state</p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.subscription) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>KiloClaw</CardTitle>
              <CardDescription>n/a</CardDescription>
            </div>
            {data?.activeInstanceId && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/admin/kiloclaw/${data.activeInstanceId}`}>
                  <ExternalLink className="mr-1 h-3 w-3" />
                  View KiloClaw
                </Link>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {data?.earlybird ? (
            <div className="rounded-lg border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">Earlybird Access</span>
                <Badge className={getAccessBadgeClass(data.hasAccess)}>
                  {data.hasAccess ? 'has access' : 'no access'}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
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
          ) : (
            <p className="text-muted-foreground text-sm">
              This user does not have a KiloClaw subscription row.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const { subscription } = data;
  const canEditTrialEnd = subscription.status === 'trialing' || subscription.status === 'canceled';
  const isTrialReset = subscription.status === 'canceled';

  return (
    <>
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>KiloClaw</CardTitle>
              <CardDescription>KiloClaw subscription and trial status</CardDescription>
            </div>
            <div className="flex gap-2">
              {data.activeInstanceId && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/admin/kiloclaw/${data.activeInstanceId}`}>
                    <ExternalLink className="mr-1 h-3 w-3" />
                    View KiloClaw
                  </Link>
                </Button>
              )}
              {canEditTrialEnd && (
                <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                  {isTrialReset ? 'Reset Trial' : 'Edit Trial End'}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Access</h4>
              <Badge className={getAccessBadgeClass(data.hasAccess)}>
                {data.hasAccess ? 'has access' : 'no access'}
              </Badge>
              {data.accessReason ? (
                <p className="text-muted-foreground mt-1 text-xs">{data.accessReason}</p>
              ) : null}
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Status</h4>
              <Badge className={getSubscriptionStatusBadgeClass(subscription.status)}>
                {subscription.status}
              </Badge>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Plan</h4>
              <p className="text-sm font-semibold">{subscription.plan}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Trial Started</h4>
              <p className="text-sm">{formatDateOrDash(subscription.trial_started_at)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Trial Ends</h4>
              <p className="text-sm">{formatDateOrDash(subscription.trial_ends_at)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Current Period End</h4>
              <p className="text-sm">{formatDateOrDash(subscription.current_period_end)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Commit Ends</h4>
              <p className="text-sm">{formatDateOrDash(subscription.commit_ends_at)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Scheduled Plan</h4>
              <p className="text-sm">{subscription.scheduled_plan ?? '—'}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Scheduled By</h4>
              <p className="text-sm">{subscription.scheduled_by ?? '—'}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Suspended At</h4>
              <p className="text-sm">{formatDateOrDash(subscription.suspended_at)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Destruction Deadline</h4>
              <p className="text-sm">{formatDateOrDash(subscription.destruction_deadline)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-xs font-medium">Updated</h4>
              <p className="text-sm">{formatDate(subscription.updated_at)}</p>
            </div>
          </div>

          {data.earlybird ? (
            <div className="rounded-lg border p-3">
              <h4 className="mb-2 text-sm font-medium">Earlybird</h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
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
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isTrialReset ? 'Reset KiloClaw Trial' : 'Edit KiloClaw Trial End Date'}
            </DialogTitle>
            <DialogDescription>
              {isTrialReset
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
              onClick={() => setDialogOpen(false)}
              disabled={updateTrialEndAt.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateTrialEndAt.isPending || !selectedDate}>
              {updateTrialEndAt.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
