'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';

export function ContainerTab({ townId }: { townId: string }) {
  const trpc = useTRPC();

  const [showRestartDialog, setShowRestartDialog] = useState(false);

  const healthQuery = useQuery(trpc.admin.gastown.getTownHealth.queryOptions({ townId }));
  const eventsQuery = useQuery(trpc.admin.gastown.listContainerEvents.queryOptions({ townId }));
  const configQuery = useQuery(trpc.admin.gastown.getTownConfig.queryOptions({ townId }));

  const forceRestartMutation = useMutation(
    trpc.admin.gastown.forceRestartContainer.mutationOptions({
      onSuccess: () => {
        setShowRestartDialog(false);
        toast.success('Container restart requested');
      },
      onError: err => {
        toast.error(`Failed to restart container: ${err.message}`);
      },
    })
  );

  const health = healthQuery.data;
  const containerEvents = eventsQuery.data ?? [];
  const envVars = configQuery.data?.env_vars ?? {};

  // Derive container health status from the alarm status snapshot
  let containerStatus: 'running' | 'stopped' | 'unknown' = 'unknown';
  if (health) {
    const hasDeadAgents = health.agents.dead > 0;
    const hasWorkingAgents = health.agents.working > 0;
    if (hasWorkingAgents) {
      containerStatus = 'running';
    } else if (hasDeadAgents) {
      containerStatus = 'stopped';
    } else {
      containerStatus = 'running'; // idle but alive
    }
  }

  const healthBadgeClass =
    containerStatus === 'running'
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : containerStatus === 'stopped'
        ? 'bg-red-500/10 text-red-400 border-red-500/20'
        : 'bg-gray-500/10 text-gray-400 border-gray-500/20';

  return (
    <div className="flex flex-col gap-4">
      {/* Health & Actions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Container Health</CardTitle>
            <Button
              variant="outline"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() => setShowRestartDialog(true)}
            >
              Force Restart Container
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {healthQuery.isLoading && (
            <p className="text-muted-foreground text-sm">Loading health status…</p>
          )}
          {healthQuery.isError && (
            <p className="text-sm text-red-400">
              Failed to load container health: {healthQuery.error.message}
            </p>
          )}
          {!healthQuery.isLoading && !healthQuery.isError && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-sm">Status:</span>
                <Badge variant="outline" className={healthBadgeClass}>
                  {containerStatus}
                </Badge>
              </div>
              {health && (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div className="rounded-lg border p-3">
                    <div className="text-muted-foreground text-xs">Working Agents</div>
                    <div className="mt-1 text-2xl font-semibold">{health.agents.working}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-muted-foreground text-xs">Idle Agents</div>
                    <div className="mt-1 text-2xl font-semibold">{health.agents.idle}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-muted-foreground text-xs">Dead Agents</div>
                    <div className="mt-1 text-2xl font-semibold text-red-400">
                      {health.agents.dead}
                    </div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-muted-foreground text-xs">Open Beads</div>
                    <div className="mt-1 text-2xl font-semibold">{health.beads.open}</div>
                  </div>
                </div>
              )}
              {health && (
                <div>
                  <div className="text-muted-foreground mb-1 text-xs">Alarm interval</div>
                  <div className="text-sm">{health.alarm.intervalLabel}</div>
                  {health.alarm.nextFireAt && (
                    <div className="text-muted-foreground text-xs">
                      Next:{' '}
                      {formatDistanceToNow(new Date(health.alarm.nextFireAt), { addSuffix: true })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Events */}
      <Card>
        <CardHeader>
          <CardTitle>Container Events</CardTitle>
        </CardHeader>
        <CardContent>
          {eventsQuery.isLoading && (
            <p className="text-muted-foreground text-sm">Loading events…</p>
          )}
          {!eventsQuery.isLoading && containerEvents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No container events. (Requires bead 0 admin endpoints.)
            </p>
          )}
          {containerEvents.length > 0 && (
            <div className="space-y-2">
              {containerEvents.map(event => (
                <div key={event.id} className="flex items-start justify-between gap-4 text-sm">
                  <div>
                    <span className="font-mono text-xs">{event.event_type}</span>
                    {event.data && Object.keys(event.data).length > 0 && (
                      <pre className="text-muted-foreground mt-1 font-mono text-xs whitespace-pre-wrap">
                        {JSON.stringify(event.data, null, 2)}
                      </pre>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <CardTitle>Environment Variables</CardTitle>
        </CardHeader>
        <CardContent>
          {configQuery.isLoading && (
            <p className="text-muted-foreground text-sm">Loading config…</p>
          )}
          {!configQuery.isLoading && Object.keys(envVars).length === 0 && (
            <p className="text-muted-foreground text-sm">No environment variables configured.</p>
          )}
          {Object.keys(envVars).length > 0 && (
            <div className="space-y-1">
              {Object.keys(envVars)
                .sort()
                .map(key => (
                  <div key={key} className="flex items-center gap-4 font-mono text-sm">
                    <span className="text-foreground min-w-48">{key}</span>
                    <span className="text-muted-foreground">••••••••</span>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force Restart Container</DialogTitle>
            <DialogDescription>
              This will force-restart the Gastown container for this town. All running agents will
              be interrupted. This action is logged in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRestartDialog(false)}
              disabled={forceRestartMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => forceRestartMutation.mutate({ townId })}
              disabled={forceRestartMutation.isPending}
            >
              {forceRestartMutation.isPending ? 'Restarting…' : 'Force Restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
