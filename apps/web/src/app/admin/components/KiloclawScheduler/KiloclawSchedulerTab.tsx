'use client';

/**
 * Scheduler tab — admin operational view for scheduled admin actions
 * across instances. Currently supports `scheduled_restart`; future
 * action types (`version_change` and friends) plug in here as new
 * forms alongside the table of recent actions.
 *
 * Two sections:
 *   - "Schedule a restart" form — type an instance UUID, pick a future
 *     datetime, optional reason, hit Schedule.
 *   - "Recent scheduled actions" table — scheduled actions across the
 *     fleet with status, target instance, counters, and a cancel
 *     button for pending rows.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '../KiloclawInstances/shared';

const statusBadgeClass: Record<string, string> = {
  scheduled: 'border-transparent bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/20',
  running: 'border-transparent bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/20',
  completed: 'border-transparent bg-green-500/20 text-green-400 ring-1 ring-green-500/20',
  cancelled: 'border-transparent bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/20',
  failed: 'border-transparent bg-red-500/20 text-red-400 ring-1 ring-red-500/20',
};

function defaultScheduledAt(): string {
  // Default = now + 5 minutes (UTC ISO truncated to minutes for the
  // datetime-local input).
  const d = new Date(Date.now() + 5 * 60_000);
  // datetime-local needs YYYY-MM-DDTHH:mm (no seconds, no zone).
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function KiloclawSchedulerTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [instanceId, setInstanceId] = useState('');
  const [scheduledAtLocal, setScheduledAtLocal] = useState(defaultScheduledAt);
  const [reason, setReason] = useState('');

  const list = useQuery(
    trpc.admin.kiloclawInstances.listScheduledActions.queryOptions({
      offset: 0,
      limit: 50,
    })
  );

  const schedule = useMutation(
    trpc.admin.kiloclawInstances.scheduleAction.mutationOptions({
      onSuccess: () => {
        setReason('');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.listScheduledActions.queryKey(),
        });
      },
    })
  );

  const cancel = useMutation(
    trpc.admin.kiloclawInstances.cancelScheduledAction.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.listScheduledActions.queryKey(),
        });
      },
    })
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Convert datetime-local (no zone) to ISO with the user's local zone
    // applied (so admin picks "3pm" in their TZ and the backend stores
    // the right UTC instant).
    const local = new Date(scheduledAtLocal);
    schedule.mutate({
      actionType: 'scheduled_restart',
      instanceId: instanceId.trim(),
      scheduledAt: local.toISOString(),
      reason: reason.trim() || undefined,
    });
  };

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Scheduler</AlertTitle>
        <AlertDescription>
          Schedule and observe admin actions across instances. Currently supports{' '}
          <code className="font-mono">scheduled_restart</code> (the worker DO redeploys on its
          current image at the chosen time, no version change). Additional action types land in
          follow-up work alongside their own forms below.
          <div className="mt-2">
            <strong>Timing:</strong> actions fire on the next instance reconcile alarm tick after
            the scheduled time. Cadence is roughly 5 minutes for running instances (longer for
            hibernated). Treat the chosen time as a "no earlier than" bound, not an exact fire time.
          </div>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Schedule a restart</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="instance-id">Instance ID (UUID)</Label>
                <Input
                  id="instance-id"
                  value={instanceId}
                  onChange={e => setInstanceId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-at">Scheduled at (local time)</Label>
                <Input
                  id="scheduled-at"
                  type="datetime-local"
                  value={scheduledAtLocal}
                  onChange={e => setScheduledAtLocal(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reason">Reason (optional)</Label>
                <Input
                  id="reason"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  maxLength={256}
                />
              </div>
            </div>
            {schedule.error && (
              <Alert variant="destructive">
                <AlertTitle>Schedule failed</AlertTitle>
                <AlertDescription>
                  {schedule.error instanceof Error ? schedule.error.message : 'Unknown error'}
                </AlertDescription>
              </Alert>
            )}
            <div>
              <Button type="submit" disabled={schedule.isPending}>
                {schedule.isPending ? 'Scheduling…' : 'Schedule restart'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent scheduled actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Instance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Counts (a/s/f)</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : (list.data?.items ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center">
                      No scheduled actions yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  (list.data?.items ?? []).map(action => (
                    <TableRow key={action.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{action.action_type}</span>
                          <span className="text-muted-foreground font-mono text-xs">
                            {action.id}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {action.instance_id ? (
                          <span title={action.instance_id}>{action.instance_id}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass[action.status] ?? ''}>
                          {action.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {action.applied_count}/{action.skipped_count}/{action.failed_count} of{' '}
                        {action.total_count}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground text-sm"
                        title={new Date(action.created_at).toLocaleString()}
                      >
                        {formatRelativeTime(action.created_at)}
                      </TableCell>
                      <TableCell>
                        {(action.status === 'scheduled' || action.status === 'running') && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => cancel.mutate({ id: action.id })}
                            disabled={cancel.isPending}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
