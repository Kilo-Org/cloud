'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';

const AGENT_STATUS_COLORS: Record<string, string> = {
  working: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  idle: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  dead: 'bg-red-500/10 text-red-400 border-red-500/20',
  stalled: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

type SortDir = 'asc' | 'desc';

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function AgentInspectorDashboard({ townId, agentId }: { townId: string; agentId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [confirmReset, setConfirmReset] = useState(false);
  const [eventSearch, setEventSearch] = useState('');
  const [eventSortDir, setEventSortDir] = useState<SortDir>('desc');
  const [eventLimit, setEventLimit] = useState(500);

  // Fetch agent from list
  const agentsQuery = useQuery(trpc.admin.gastown.listAgents.queryOptions({ townId }));
  const agent = (agentsQuery.data ?? []).find(a => a.id === agentId) ?? null;

  const agentEventsQuery = useQuery(
    trpc.admin.gastown.getAgentEvents.queryOptions({ townId, agentId, limit: eventLimit })
  );

  const beadEventsQuery = useQuery(
    trpc.admin.gastown.getBeadEvents.queryOptions({ townId, limit: 500 })
  );

  const dispatchAttemptsQuery = useQuery(
    trpc.admin.gastown.listDispatchAttempts.queryOptions({ townId, agentId })
  );

  const forceResetMutation = useMutation(
    trpc.admin.gastown.forceResetAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.admin.gastown.listAgents.queryFilter({ townId }));
        setConfirmReset(false);
        toast.success('Agent reset successfully');
      },
      onError: err => {
        toast.error(`Failed to reset agent: ${err.message}`);
      },
    })
  );

  const agentEvents = agentEventsQuery.data ?? [];
  const allBeadEvents = beadEventsQuery.data ?? [];
  const dispatchAttempts = dispatchAttemptsQuery.data ?? [];

  // Events related to this agent from bead events
  const agentBeadEvents = allBeadEvents.filter(e => e.agent_id === agentId);

  // Deduplicated bead IDs that this agent was ever hooked to
  const hookedBeadIds = Array.from(new Set(agentBeadEvents.map(e => e.bead_id)));

  // Filtered + sorted agent events
  const filteredAgentEvents = agentEvents
    .filter(e => {
      if (!eventSearch) return true;
      return JSON.stringify(e).toLowerCase().includes(eventSearch.toLowerCase());
    })
    .sort((a, b) => {
      const ta = safeTimestamp(toRecord(a)['created_at']);
      const tb = safeTimestamp(toRecord(b)['created_at']);
      return eventSortDir === 'desc' ? tb - ta : ta - tb;
    });

  return (
    <div className="flex w-full flex-col gap-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            href={`/admin/gastown/towns/${townId}?tab=agents`}
            className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 text-sm transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Town Inspector
          </Link>
          <h1 className="text-2xl font-semibold">Agent Inspector</h1>
          <p className="text-muted-foreground font-mono text-sm">{agentId}</p>
        </div>
        {agent && (
          <Badge variant="outline" className={AGENT_STATUS_COLORS[agent.status] ?? ''}>
            {agent.status}
          </Badge>
        )}
      </div>

      {agentsQuery.isLoading && (
        <p className="text-muted-foreground py-8 text-center text-sm">Loading agent…</p>
      )}

      {agent && (
        <>
          {/* Agent overview */}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Name
                  </dt>
                  <dd className="font-semibold">{agent.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Role
                  </dt>
                  <dd className="font-mono">{agent.role}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Identity
                  </dt>
                  <dd className="font-mono text-xs">{agent.identity}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Dispatch Attempts
                  </dt>
                  <dd>{agent.dispatch_attempts}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Last Active
                  </dt>
                  <dd>
                    {agent.last_activity_at
                      ? formatDistanceToNow(new Date(agent.last_activity_at), {
                          addSuffix: true,
                        })
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Created
                  </dt>
                  <dd title={format(new Date(agent.created_at), 'PPpp')}>
                    {formatDistanceToNow(new Date(agent.created_at), { addSuffix: true })}
                  </dd>
                </div>
                {agent.current_hook_bead_id && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Current Hooked Bead
                    </dt>
                    <dd>
                      <Link
                        href={`/admin/gastown/towns/${townId}/beads/${agent.current_hook_bead_id}`}
                        className="font-mono text-xs text-blue-400 hover:underline"
                      >
                        {agent.current_hook_bead_id.slice(0, 8)}…
                      </Link>
                    </dd>
                  </div>
                )}
                {agent.rig_id && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Rig
                    </dt>
                    <dd className="font-mono text-xs">{agent.rig_id.slice(0, 8)}…</dd>
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
              <Button
                variant="outline"
                size="sm"
                className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={() => setConfirmReset(true)}
              >
                Force Reset Agent
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {/* Current/Past Hooked Beads */}
      <Card>
        <CardHeader>
          <CardTitle>Hooked Beads</CardTitle>
        </CardHeader>
        <CardContent>
          {beadEventsQuery.isLoading && (
            <p className="text-muted-foreground py-4 text-center text-sm">Loading…</p>
          )}
          {!beadEventsQuery.isLoading && hookedBeadIds.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">
              No bead history found for this agent.
            </p>
          )}
          {hookedBeadIds.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-muted-foreground pb-2 text-left font-medium">Bead</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Events</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Last Event</th>
                  </tr>
                </thead>
                <tbody>
                  {hookedBeadIds.map(bid => {
                    const beadEvs = agentBeadEvents.filter(e => e.bead_id === bid);
                    const latest = beadEvs.reduce((a, b) =>
                      new Date(a.created_at) > new Date(b.created_at) ? a : b
                    );
                    return (
                      <tr key={bid} className="hover:bg-muted/40 border-b transition-colors">
                        <td className="py-2 pr-4">
                          <Link
                            href={`/admin/gastown/towns/${townId}/beads/${bid}`}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            {bid.slice(0, 8)}…
                          </Link>
                        </td>
                        <td className="text-muted-foreground py-2 pr-4 text-center text-xs">
                          {beadEvs.length}
                        </td>
                        <td
                          className="text-muted-foreground py-2 text-xs"
                          title={format(new Date(latest.created_at), 'PPpp')}
                        >
                          {formatDistanceToNow(new Date(latest.created_at), {
                            addSuffix: true,
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Status Timeline */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Status Timeline</CardTitle>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search events…"
                value={eventSearch}
                onChange={e => setEventSearch(e.target.value)}
                className="h-8 w-48 text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => setEventSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
              >
                Time
                {eventSortDir === 'desc' ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronUp className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {agentEventsQuery.isLoading && (
            <p className="text-muted-foreground py-4 text-center text-sm">Loading events…</p>
          )}
          {!agentEventsQuery.isLoading && filteredAgentEvents.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {agentEvents.length === 0
                ? 'No agent events found. (Requires bead 0 admin endpoints.)'
                : 'No events match the current search.'}
            </p>
          )}
          {filteredAgentEvents.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-muted-foreground pb-2 text-left font-medium">Time</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Event</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgentEvents.map((rawEvent, idx) => {
                    const ev = toRecord(rawEvent);
                    const eventId =
                      safeString(ev['id']) || safeString(ev['agent_event_id']) || String(idx);
                    const createdAt = safeString(ev['created_at']);
                    const eventType = safeString(ev['event_type']);
                    const oldValue = typeof ev['old_value'] === 'string' ? ev['old_value'] : null;
                    const newValue = typeof ev['new_value'] === 'string' ? ev['new_value'] : null;
                    return (
                      <tr key={eventId} className="hover:bg-muted/40 border-b transition-colors">
                        <td
                          className="text-muted-foreground py-2 pr-4 text-xs"
                          title={createdAt ? format(new Date(createdAt), 'PPpp') : ''}
                        >
                          {createdAt
                            ? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
                            : '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono text-xs">
                            {eventType}
                          </span>
                        </td>
                        <td className="py-2 text-xs">
                          {(oldValue ?? newValue) ? (
                            <div className="flex flex-wrap items-center gap-1">
                              {oldValue && (
                                <span className="rounded bg-red-500/10 px-1 py-0.5 font-mono text-red-400 line-through">
                                  {String(oldValue).length > 40
                                    ? `${String(oldValue).slice(0, 40)}…`
                                    : String(oldValue)}
                                </span>
                              )}
                              {oldValue && newValue && (
                                <span className="text-muted-foreground">→</span>
                              )}
                              {newValue && (
                                <span className="rounded bg-green-500/10 px-1 py-0.5 font-mono text-green-400">
                                  {String(newValue).length > 40
                                    ? `${String(newValue).slice(0, 40)}…`
                                    : String(newValue)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {agentEvents.length >= eventLimit && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEventLimit(l => l + 500)}
                disabled={agentEventsQuery.isFetching}
              >
                {agentEventsQuery.isFetching
                  ? 'Loading…'
                  : `Load more (showing ${agentEvents.length})`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dispatch Attempts */}
      <Card>
        <CardHeader>
          <CardTitle>Dispatch Attempt History</CardTitle>
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
                    <th className="text-muted-foreground pb-2 text-left font-medium">Bead</th>
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
                        {attempt.bead_id ? (
                          <Link
                            href={`/admin/gastown/towns/${townId}/beads/${attempt.bead_id}`}
                            className="font-mono text-xs text-blue-400 hover:underline"
                          >
                            {attempt.bead_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="max-w-xs py-2 text-xs text-red-400">
                        {attempt.error_message ? (
                          <span title={attempt.error_message}>
                            {attempt.error_message.length > 80
                              ? `${attempt.error_message.slice(0, 80)}…`
                              : attempt.error_message}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm Reset AlertDialog */}
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force Reset Agent</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset agent{' '}
              <span className="font-semibold">{agent?.name ?? agentId.slice(0, 8)}</span> to idle
              status and unhook any hooked bead. This action is logged in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceResetMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => forceResetMutation.mutate({ townId, agentId })}
              disabled={forceResetMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {forceResetMutation.isPending ? 'Resetting…' : 'Force Reset'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
