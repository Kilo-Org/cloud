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
import { useMemo, useState } from 'react';
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
import { ArrowDown, ArrowUp, ArrowUpDown, Info } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatRelativeTime } from '../KiloclawInstances/shared';
import { defaultScheduledAt } from '@/lib/kiloclaw/scheduled-action-form';

// Per design.md: every status badge is `bg-{color}-500/20 text-{color}-400
// ring-1 ring-{color}-500/20`. Color assignments are fixed by domain —
// blue for neutral default, yellow for in-progress/warning, green for
// success, zinc for terminal-but-quiet, red for errors.
const statusBadgeClass: Record<string, string> = {
  scheduled: 'border-transparent bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/20',
  running: 'border-transparent bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20',
  completed: 'border-transparent bg-green-500/20 text-green-400 ring-1 ring-green-500/20',
  cancelled: 'border-transparent bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/20',
  failed: 'border-transparent bg-red-500/20 text-red-400 ring-1 ring-red-500/20',
};

// defaultScheduledAt is shared with the Change Version dialogs (bulk
// + per instance) — see `@/lib/kiloclaw/scheduled-action-form`.

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

  // Client-side sort over the current page of listScheduledActions.
  // The list is paginated server-side (limit 50) and ordered by
  // created_at desc; this re-sorts whatever rows are on screen. For
  // multi-page sort we'd need to push sortBy/sortDir through the tRPC
  // input; defer until pagination becomes an actual constraint.
  type SortKey =
    | 'action_type'
    | 'target_count'
    | 'status'
    | 'applied_count'
    | 'skipped_count'
    | 'failed_count'
    | 'scheduled_at'
    | 'created_at';
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // Detail-dialog state. Holds the action id whose target list is open.
  const [viewingActionId, setViewingActionId] = useState<string | null>(null);
  const detail = useQuery(
    trpc.admin.kiloclawInstances.getScheduledAction.queryOptions(
      { id: viewingActionId ?? '' },
      { enabled: viewingActionId !== null }
    )
  );

  const list = useQuery(
    trpc.admin.kiloclawInstances.listScheduledActions.queryOptions({
      offset: 0,
      limit: 50,
    })
  );

  // Stable sort across the current page. Server returns sorted by
  // created_at desc; we override locally based on header clicks.
  const sortedItems = useMemo(() => {
    const items = list.data?.items ?? [];
    const dirSign = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: (typeof items)[number], b: (typeof items)[number]) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls always sort last regardless of direction so empty
      // scheduled_at rows don't float above real data on asc.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dirSign;
      return String(av).localeCompare(String(bv)) * dirSign;
    };
    return [...items].sort(cmp);
  }, [list.data?.items, sortKey, sortDir]);

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
        <Info className="h-4 w-4" />
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
          <div className="mt-2">
            <strong>Notifications:</strong> not implemented yet. End users get no warning before
            their session is interrupted at the scheduled time. Use cautiously on customer instances
            until the notifications work lands.
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
                  <SortableTh
                    sortKey="action_type"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  >
                    Action
                  </SortableTh>
                  <SortableTh
                    sortKey="target_count"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  >
                    Instances
                  </SortableTh>
                  <SortableTh
                    sortKey="status"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  >
                    Status
                  </SortableTh>
                  <SortableTh
                    sortKey="applied_count"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    align="right"
                  >
                    Applied
                  </SortableTh>
                  <SortableTh
                    sortKey="skipped_count"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    align="right"
                  >
                    Skipped
                  </SortableTh>
                  <SortableTh
                    sortKey="failed_count"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    align="right"
                  >
                    Failed
                  </SortableTh>
                  <SortableTh
                    sortKey="scheduled_at"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    title="When the action is scheduled to run (no earlier than)"
                  >
                    Run at
                  </SortableTh>
                  <SortableTh
                    sortKey="created_at"
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  >
                    Created
                  </SortableTh>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-16 text-center">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : sortedItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-16 text-center">
                      No scheduled actions yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedItems.map(action => (
                    <TableRow key={action.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{action.action_type}</span>
                          <span className="text-muted-foreground font-mono text-xs">
                            {action.id}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {action.target_count === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : action.target_count === 1 && action.first_instance_id ? (
                          <span className="font-mono" title={action.first_instance_id}>
                            {action.first_instance_id}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {action.target_count} instances
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass[action.status] ?? ''}>
                          {action.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {action.applied_count}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {action.skipped_count}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {action.failed_count}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground font-mono text-xs"
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
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setViewingActionId(action.id)}
                          >
                            View
                          </Button>
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
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Per-action detail dialog. Lists all targets with their per-instance
          outcome — the listScheduledActions row only shows aggregate counts
          and a single representative instance, so this is where bulk actions
          actually become inspectable. */}
      <Dialog
        open={viewingActionId !== null}
        onOpenChange={open => {
          if (!open) setViewingActionId(null);
        }}
      >
        <DialogContent className="max-h-[80vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Scheduled action detail</DialogTitle>
            <DialogDescription>
              {detail.data ? (
                <span className="font-mono text-xs">{detail.data.action.id}</span>
              ) : (
                'Loading…'
              )}
            </DialogDescription>
          </DialogHeader>

          {detail.isLoading && (
            <div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>
          )}

          {detail.data && (
            <div className="space-y-4 overflow-y-auto">
              <div className="bg-muted/30 rounded-md border p-3 text-sm">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  <div>
                    <span className="text-muted-foreground">Type:</span>{' '}
                    <span className="font-medium">{detail.data.action.action_type}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status:</span>{' '}
                    <Badge
                      variant="outline"
                      className={statusBadgeClass[detail.data.action.status] ?? ''}
                    >
                      {detail.data.action.status}
                    </Badge>
                  </div>
                  {detail.data.action.target_image_tag && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Target tag:</span>{' '}
                      <code className="font-mono text-xs">
                        {detail.data.action.target_image_tag}
                      </code>
                    </div>
                  )}
                  {detail.data.action.action_type === 'version_change' && (
                    <div>
                      <span className="text-muted-foreground">Override pins:</span>{' '}
                      {detail.data.action.override_pins ? 'yes' : 'no'}
                    </div>
                  )}
                  {detail.data.action.reason && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Reason:</span>{' '}
                      {detail.data.action.reason}
                    </div>
                  )}
                </div>
              </div>

              <div className="text-sm font-medium">Targets ({detail.data.targets.length})</div>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Instance</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>From → To</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.data.targets.map(t => (
                      <TableRow key={t.id}>
                        <TableCell className="font-mono text-xs">
                          {t.instance_sandbox_id ? (
                            <span title={t.instance_id}>{t.instance_sandbox_id}</span>
                          ) : (
                            <span title={t.instance_id}>{t.instance_id}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="text-muted-foreground">{t.user_email ?? t.user_id}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {t.target_image_tag ? (
                            <span>
                              <span className="text-muted-foreground">
                                {t.source_image_tag ?? '—'}
                              </span>
                              <span className="text-muted-foreground mx-1">→</span>
                              <span>{t.target_image_tag}</span>
                            </span>
                          ) : (
                            // scheduled_restart targets have no target tag.
                            <span className="text-muted-foreground">
                              {t.source_image_tag ?? '—'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusBadgeClass[t.status] ?? ''}>
                            {t.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {t.skip_reason && <span>skip: {t.skip_reason}</span>}
                          {t.error_message && (
                            <span className="text-red-400" title={t.error_message}>
                              {t.error_message.length > 80
                                ? t.error_message.slice(0, 80) + '…'
                                : t.error_message}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type SortableThProps<K extends string> = {
  sortKey: K;
  activeKey: K;
  dir: 'asc' | 'desc';
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  title?: string;
  children: React.ReactNode;
};

function SortableTh<K extends string>({
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
  title,
  children,
}: SortableThProps<K>) {
  const isActive = sortKey === activeKey;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined} title={title}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`hover:text-foreground inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <span>{children}</span>
        <Icon className={`h-3 w-3 ${isActive ? 'text-foreground' : 'text-muted-foreground/60'}`} />
      </button>
    </TableHead>
  );
}
