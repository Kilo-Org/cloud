'use client';

/**
 * Scheduler tab — admin operational view for scheduled admin actions
 * across instances. Currently supports `scheduled_restart` and
 * `version_change`; future action types plug in here as new forms
 * alongside the table of recent actions.
 *
 * Sections:
 *   - "Schedule a restart" form — instance UUID + future datetime +
 *     optional reason. Always available.
 *   - "Schedule a version change" form — instance UUID + target version
 *     + override pins + datetime + reason.
 *   - "Recent scheduled actions" table — actions across the fleet with
 *     status, target instance, counters, and a cancel button for
 *     pending rows.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

  // Restart form state
  const [restartInstanceId, setRestartInstanceId] = useState('');
  const [restartScheduledAt, setRestartScheduledAt] = useState(defaultScheduledAt);
  const [restartReason, setRestartReason] = useState('');

  // Version-change form state
  const [vcInstanceId, setVcInstanceId] = useState('');
  const [vcImageTag, setVcImageTag] = useState('');
  const [vcOverridePins, setVcOverridePins] = useState(false);
  const [vcScheduledAt, setVcScheduledAt] = useState(defaultScheduledAt);
  const [vcReason, setVcReason] = useState('');

  const list = useQuery(
    trpc.admin.kiloclawInstances.listScheduledActions.queryOptions({
      offset: 0,
      limit: 50,
    })
  );

  // Same listVersions query the bulk dialog uses. Status filter
  // 'available' so disabled tags can't be picked from the dropdown
  // (the backend rejects them too, but no point offering them in UI).
  const versions = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({
      offset: 0,
      limit: 100,
      status: 'available',
    })
  );

  const schedule = useMutation(
    trpc.admin.kiloclawInstances.scheduleAction.mutationOptions({
      onSuccess: () => {
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

  const onSubmitRestart = (e: React.FormEvent) => {
    e.preventDefault();
    // Convert datetime-local (no zone) to ISO with the user's local zone
    // applied (so admin picks "3pm" in their TZ and the backend stores
    // the right UTC instant).
    const local = new Date(restartScheduledAt);
    schedule.mutate(
      {
        actionType: 'scheduled_restart',
        instanceIds: [restartInstanceId.trim()],
        scheduledAt: local.toISOString(),
        reason: restartReason.trim() || undefined,
      },
      {
        onSuccess: () => {
          setRestartReason('');
        },
      }
    );
  };

  const onSubmitVersionChange = (e: React.FormEvent) => {
    e.preventDefault();
    const local = new Date(vcScheduledAt);
    schedule.mutate(
      {
        actionType: 'version_change',
        instanceIds: [vcInstanceId.trim()],
        imageTag: vcImageTag,
        overridePins: vcOverridePins,
        scheduledAt: local.toISOString(),
        reason: vcReason.trim() || undefined,
      },
      {
        onSuccess: () => {
          setVcReason('');
        },
      }
    );
  };

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Scheduler</AlertTitle>
        <AlertDescription>
          Schedule and observe admin actions across instances. Currently supports{' '}
          <code className="font-mono">scheduled_restart</code> (the worker DO redeploys on its
          current image at the chosen time) and <code className="font-mono">version_change</code>{' '}
          (the worker DO redeploys on a new image tag at the chosen time, with optional pin
          override). Additional action types land in follow-up work alongside their own forms below.
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
          <form onSubmit={onSubmitRestart} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="restart-instance-id">Instance ID (UUID)</Label>
                <Input
                  id="restart-instance-id"
                  value={restartInstanceId}
                  onChange={e => setRestartInstanceId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="restart-scheduled-at">Scheduled at (local time)</Label>
                <Input
                  id="restart-scheduled-at"
                  type="datetime-local"
                  value={restartScheduledAt}
                  onChange={e => setRestartScheduledAt(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="restart-reason">Reason (optional)</Label>
                <Input
                  id="restart-reason"
                  value={restartReason}
                  onChange={e => setRestartReason(e.target.value)}
                  maxLength={256}
                />
              </div>
            </div>
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
          <CardTitle>Schedule a version change</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmitVersionChange} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="vc-instance-id">Instance ID (UUID)</Label>
                <Input
                  id="vc-instance-id"
                  value={vcInstanceId}
                  onChange={e => setVcInstanceId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vc-image-tag">Target version</Label>
                <Select value={vcImageTag} onValueChange={setVcImageTag}>
                  <SelectTrigger id="vc-image-tag">
                    <SelectValue placeholder="Select an image tag…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(versions.data?.items ?? []).map(v => (
                      <SelectItem key={v.image_tag} value={v.image_tag}>
                        <span>
                          <span className="font-medium">{v.openclaw_version}</span>
                          <span className="text-muted-foreground ml-2 font-mono text-xs">
                            {v.image_tag}
                          </span>
                          {v.is_latest ? (
                            <span className="text-muted-foreground ml-2 text-xs">(latest)</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="vc-scheduled-at">Scheduled at (local time)</Label>
                <Input
                  id="vc-scheduled-at"
                  type="datetime-local"
                  value={vcScheduledAt}
                  onChange={e => setVcScheduledAt(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vc-reason">Reason (optional)</Label>
                <Input
                  id="vc-reason"
                  value={vcReason}
                  onChange={e => setVcReason(e.target.value)}
                  maxLength={256}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="vc-override-pins"
                checked={vcOverridePins}
                onCheckedChange={checked => setVcOverridePins(checked === true)}
              />
              <Label htmlFor="vc-override-pins" className="cursor-pointer text-sm font-normal">
                Override existing pins (deletes any user/admin pin row at apply time so the version
                change isn't blocked)
              </Label>
            </div>
            <div>
              <Button type="submit" disabled={schedule.isPending || !vcImageTag}>
                {schedule.isPending ? 'Scheduling…' : 'Schedule version change'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {schedule.error && (
        <Alert variant="destructive">
          <AlertTitle>Last schedule attempt failed</AlertTitle>
          <AlertDescription>
            {schedule.error instanceof Error ? schedule.error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      )}

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
                  <TableHead>Scheduled at</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-16 text-center">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : (list.data?.items ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-16 text-center">
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
                        title={
                          action.scheduled_at
                            ? new Date(action.scheduled_at).toLocaleString()
                            : undefined
                        }
                      >
                        {action.scheduled_at ? (
                          <span>{new Date(action.scheduled_at).toLocaleString()}</span>
                        ) : (
                          <span>—</span>
                        )}
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
