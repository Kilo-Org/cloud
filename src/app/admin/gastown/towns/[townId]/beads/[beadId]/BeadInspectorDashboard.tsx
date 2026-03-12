'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import Link from 'next/link';
import { formatDistanceToNow, format } from 'date-fns';
import { ArrowLeft } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  closed: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

type ConfirmActionType = 'close' | 'fail' | 'reset_agent';

type ConfirmAction = {
  type: ConfirmActionType;
  label: string;
  description: string;
};

export function BeadInspectorDashboard({ townId, beadId }: { townId: string; beadId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  // Fetch the specific bead by ID (not limited by pagination).
  const beadQuery = useQuery(trpc.admin.gastown.getBead.queryOptions({ townId, beadId }));
  const bead = beadQuery.data ?? null;

  // Fetch all beads for computing the dependency graph.
  const allBeadsQuery = useQuery(trpc.admin.gastown.listBeads.queryOptions({ townId }));
  const allBeads = allBeadsQuery.data ?? [];

  const eventsQuery = useQuery(
    trpc.admin.gastown.getBeadEvents.queryOptions({ townId, beadId, limit: 500 })
  );

  const dispatchAttemptsQuery = useQuery(
    trpc.admin.gastown.listDispatchAttempts.queryOptions({ townId, beadId })
  );

  const invalidateAll = () => {
    void queryClient.invalidateQueries(trpc.admin.gastown.getBead.queryFilter({ townId, beadId }));
    void queryClient.invalidateQueries(trpc.admin.gastown.listBeads.queryFilter({ townId }));
    void queryClient.invalidateQueries(trpc.admin.gastown.getBeadEvents.queryFilter({ townId }));
  };

  const forceCloseMutation = useMutation(
    trpc.admin.gastown.forceCloseBead.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        setConfirmAction(null);
        toast.success('Bead closed successfully');
      },
      onError: err => {
        toast.error(`Failed to close bead: ${err.message}`);
      },
    })
  );

  const forceFailMutation = useMutation(
    trpc.admin.gastown.forceFailBead.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        setConfirmAction(null);
        toast.success('Bead marked as failed');
      },
      onError: err => {
        toast.error(`Failed to fail bead: ${err.message}`);
      },
    })
  );

  const forceResetAgentMutation = useMutation(
    trpc.admin.gastown.forceResetAgent.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        setConfirmAction(null);
        toast.success('Agent reset successfully');
      },
      onError: err => {
        toast.error(`Failed to reset agent: ${err.message}`);
      },
    })
  );

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'close') {
      forceCloseMutation.mutate({ townId, beadId });
    } else if (confirmAction.type === 'fail') {
      forceFailMutation.mutate({ townId, beadId });
    } else if (confirmAction.type === 'reset_agent' && bead?.assignee_agent_bead_id) {
      forceResetAgentMutation.mutate({ townId, agentId: bead.assignee_agent_bead_id });
    }
  };

  const isMutating =
    forceCloseMutation.isPending ||
    forceFailMutation.isPending ||
    forceResetAgentMutation.isPending;

  // Filter events to only those for this bead
  const events = (eventsQuery.data ?? []).filter(e => e.bead_id === beadId);
  const dispatchAttempts = dispatchAttemptsQuery.data ?? [];

  // Dependency graph: reads from metadata.depends_on as a temporary fallback.
  // The canonical source is the bead_dependencies table, but that requires a
  // dedicated admin endpoint (bead 0). Once available, switch to querying
  // bead_dependencies for accurate blocker/convoy/tracks edges.
  const getMetaDeps = (meta: Record<string, unknown>): string[] => {
    const raw = meta['depends_on'];
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  };

  const thisBeadDeps = bead != null ? getMetaDeps(bead.metadata) : [];
  const dependsOnBeads = allBeads.filter(b => thisBeadDeps.includes(b.bead_id));

  // Beads that depend on this bead
  const dependentBeads = allBeads.filter(b => getMetaDeps(b.metadata).includes(beadId));

  // Agent history from events (deduplicated)
  const agentHistory = Array.from(
    new Map(events.filter(e => e.agent_id != null).map(e => [e.agent_id, e])).values()
  );

  // Convoy membership
  const rawConvoyId = bead != null ? bead.metadata['convoy_id'] : undefined;
  const convoyId = typeof rawConvoyId === 'string' ? rawConvoyId : undefined;
  const convoyBead = convoyId ? allBeads.find(b => b.bead_id === convoyId) : undefined;

  return (
    <div className="flex w-full flex-col gap-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            href={`/admin/gastown/towns/${townId}?tab=beads`}
            className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 text-sm transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Town Inspector
          </Link>
          <h1 className="text-2xl font-semibold">Bead Inspector</h1>
          <p className="text-muted-foreground font-mono text-sm">{beadId}</p>
        </div>
        {bead && (
          <Badge variant="outline" className={STATUS_COLORS[bead.status] ?? ''}>
            {bead.status}
          </Badge>
        )}
      </div>

      {beadQuery.isLoading && (
        <p className="text-muted-foreground py-8 text-center text-sm">Loading bead…</p>
      )}
      {beadQuery.isError && (
        <p className="py-8 text-center text-sm text-red-400">
          Failed to load bead: {beadQuery.error.message}
        </p>
      )}

      {bead && (
        <>
          {/* Bead summary */}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Type
                  </dt>
                  <dd className="font-mono">{bead.type}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Priority
                  </dt>
                  <dd className="font-mono">{bead.priority}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Created
                  </dt>
                  <dd title={format(new Date(bead.created_at), 'PPpp')}>
                    {formatDistanceToNow(new Date(bead.created_at), { addSuffix: true })}
                  </dd>
                </div>
                {bead.closed_at && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Closed
                    </dt>
                    <dd title={format(new Date(bead.closed_at), 'PPpp')}>
                      {formatDistanceToNow(new Date(bead.closed_at), { addSuffix: true })}
                    </dd>
                  </div>
                )}
                {bead.assignee_agent_bead_id && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Assigned Agent
                    </dt>
                    <dd>
                      <Link
                        href={`/admin/gastown/towns/${townId}/agents/${bead.assignee_agent_bead_id}`}
                        className="font-mono text-blue-400 hover:underline"
                      >
                        {bead.assignee_agent_bead_id.slice(0, 8)}…
                      </Link>
                    </dd>
                  </div>
                )}
                {bead.rig_id && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Rig
                    </dt>
                    <dd className="font-mono text-xs">{bead.rig_id.slice(0, 8)}…</dd>
                  </div>
                )}
                {bead.labels.length > 0 && (
                  <div className="col-span-2 md:col-span-3">
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Labels
                    </dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {bead.labels.map(label => (
                        <Badge key={label} variant="outline" className="font-mono text-xs">
                          {label}
                        </Badge>
                      ))}
                    </dd>
                  </div>
                )}
                {bead.title && (
                  <div className="col-span-2 md:col-span-3">
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Title
                    </dt>
                    <dd>{bead.title}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Admin Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Admin Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bead.status === 'closed' || bead.status === 'failed'}
                  onClick={() =>
                    setConfirmAction({
                      type: 'close',
                      label: 'Force Close Bead',
                      description: `This will force-close bead ${beadId.slice(0, 8)}…. This action is logged in the audit trail.`,
                    })
                  }
                >
                  Force Close Bead
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                  disabled={bead.status === 'closed' || bead.status === 'failed'}
                  onClick={() =>
                    setConfirmAction({
                      type: 'fail',
                      label: 'Force Fail Bead',
                      description: `This will force-fail bead ${beadId.slice(0, 8)}…. This action is logged in the audit trail.`,
                    })
                  }
                >
                  Force Fail Bead
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!bead.assignee_agent_bead_id}
                  onClick={() =>
                    setConfirmAction({
                      type: 'reset_agent',
                      label: 'Force Reset Assigned Agent',
                      description: `This will reset the currently assigned agent (${bead.assignee_agent_bead_id?.slice(0, 8)}…) to idle. This action is logged in the audit trail.`,
                    })
                  }
                >
                  Force Reset Assigned Agent
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* State History Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>State History</CardTitle>
        </CardHeader>
        <CardContent>
          {eventsQuery.isLoading && (
            <p className="text-muted-foreground py-4 text-center text-sm">Loading events…</p>
          )}
          {eventsQuery.isError && (
            <p className="py-4 text-center text-sm text-red-400">
              Failed to load events: {eventsQuery.error.message}
            </p>
          )}
          {!eventsQuery.isLoading && events.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">No events found.</p>
          )}
          {events.length > 0 && (
            <div className="relative ml-2 flex flex-col gap-0">
              {[...events]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map((event, idx) => (
                  <div key={event.bead_event_id} className="flex gap-4">
                    {/* Timeline line + dot */}
                    <div className="flex flex-col items-center">
                      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-400" />
                      {idx < events.length - 1 && <div className="w-px flex-1 bg-gray-700" />}
                    </div>
                    <div className="pb-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono text-xs">
                          {event.event_type}
                        </span>
                        {event.agent_id && (
                          <Link
                            href={`/admin/gastown/towns/${townId}/agents/${event.agent_id}`}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            agent {event.agent_id.slice(0, 8)}…
                          </Link>
                        )}
                        <span
                          className="text-muted-foreground text-xs"
                          title={format(new Date(event.created_at), 'PPpp')}
                        >
                          {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      {(event.old_value ?? event.new_value) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                          {event.old_value && (
                            <span className="rounded bg-red-500/10 px-1 py-0.5 font-mono text-red-400 line-through">
                              {event.old_value}
                            </span>
                          )}
                          {event.old_value && event.new_value && (
                            <span className="text-muted-foreground">→</span>
                          )}
                          {event.new_value && (
                            <span className="rounded bg-green-500/10 px-1 py-0.5 font-mono text-green-400">
                              {event.new_value}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Assigned Agent History */}
      <Card>
        <CardHeader>
          <CardTitle>Assigned Agent History</CardTitle>
        </CardHeader>
        <CardContent>
          {agentHistory.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              No agent assignments found in event history.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-muted-foreground pb-2 text-left font-medium">Agent</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Event</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {agentHistory.map(event => (
                    <tr
                      key={event.bead_event_id}
                      className="hover:bg-muted/40 border-b transition-colors"
                    >
                      <td className="py-2 pr-4">
                        <Link
                          href={`/admin/gastown/towns/${townId}/agents/${event.agent_id}`}
                          className="font-mono text-xs text-blue-400 hover:underline"
                        >
                          {event.agent_id?.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono text-xs">
                          {event.event_type}
                        </span>
                      </td>
                      <td
                        className="text-muted-foreground py-2 text-xs"
                        title={format(new Date(event.created_at), 'PPpp')}
                      >
                        {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dependency Graph */}
      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {convoyBead && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                Convoy
              </p>
              <Link
                href={`/admin/gastown/towns/${townId}/beads/${convoyBead.bead_id}`}
                className="text-sm text-blue-400 hover:underline"
              >
                <span className="font-mono text-xs">{convoyBead.bead_id.slice(0, 8)}…</span>
                {convoyBead.title && <span className="ml-2">{convoyBead.title}</span>}
              </Link>
            </div>
          )}

          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
              Depends On
            </p>
            {dependsOnBeads.length === 0 ? (
              <p className="text-muted-foreground text-sm">None</p>
            ) : (
              <ul className="space-y-1">
                {dependsOnBeads.map(b => (
                  <li key={b.bead_id}>
                    <Link
                      href={`/admin/gastown/towns/${townId}/beads/${b.bead_id}`}
                      className="text-sm text-blue-400 hover:underline"
                    >
                      <span className="font-mono text-xs">{b.bead_id.slice(0, 8)}…</span>
                      {b.title && <span className="ml-2">{b.title}</span>}
                    </Link>
                    <Badge
                      variant="outline"
                      className={`ml-2 text-xs ${STATUS_COLORS[b.status] ?? ''}`}
                    >
                      {b.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
              Depended On By
            </p>
            {dependentBeads.length === 0 ? (
              <p className="text-muted-foreground text-sm">None</p>
            ) : (
              <ul className="space-y-1">
                {dependentBeads.map(b => (
                  <li key={b.bead_id}>
                    <Link
                      href={`/admin/gastown/towns/${townId}/beads/${b.bead_id}`}
                      className="text-sm text-blue-400 hover:underline"
                    >
                      <span className="font-mono text-xs">{b.bead_id.slice(0, 8)}…</span>
                      {b.title && <span className="ml-2">{b.title}</span>}
                    </Link>
                    <Badge
                      variant="outline"
                      className={`ml-2 text-xs ${STATUS_COLORS[b.status] ?? ''}`}
                    >
                      {b.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dispatch Attempts */}
      <Card>
        <CardHeader>
          <CardTitle>Dispatch Attempts</CardTitle>
        </CardHeader>
        <CardContent>
          {dispatchAttemptsQuery.isLoading && (
            <p className="text-muted-foreground py-4 text-center text-sm">
              Loading dispatch attempts…
            </p>
          )}
          {!dispatchAttemptsQuery.isLoading && dispatchAttempts.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">
              No dispatch attempts found.
            </p>
          )}
          {dispatchAttempts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-muted-foreground pb-2 text-left font-medium">Time</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Result</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Agent</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {dispatchAttempts.map(attempt => (
                    <tr key={attempt.id} className="hover:bg-muted/40 border-b transition-colors">
                      <td
                        className="text-muted-foreground py-2 pr-4 text-xs"
                        title={format(new Date(attempt.attempted_at), 'PPpp')}
                      >
                        {formatDistanceToNow(new Date(attempt.attempted_at), {
                          addSuffix: true,
                        })}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant="outline"
                          className={
                            attempt.success
                              ? 'border-green-500/20 bg-green-500/10 text-green-400'
                              : 'border-red-500/20 bg-red-500/10 text-red-400'
                          }
                        >
                          {attempt.success ? 'Success' : 'Failed'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">
                        {attempt.agent_id ? (
                          <Link
                            href={`/admin/gastown/towns/${townId}/agents/${attempt.agent_id}`}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            {attempt.agent_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2 text-xs text-red-400">
                        {attempt.error_message ?? <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm AlertDialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.label}</AlertDialogTitle>
            <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={isMutating}
              className={
                confirmAction?.type === 'fail'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
            >
              {isMutating ? 'Processing…' : confirmAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
