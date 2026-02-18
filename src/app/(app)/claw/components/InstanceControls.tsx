'use client';

import { Play, RotateCw, Square } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Button } from '@/components/ui/button';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function InstanceControls({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const posthog = usePostHog();
  const isRunning = status.status === 'running';
  const isStopped = status.status === 'stopped' || status.status === 'provisioned';
  const isDestroying = status.status === 'destroying';

  return (
    <div>
      <h3 className="text-foreground mb-1 text-sm font-medium">Instance Controls</h3>
      <p className="text-muted-foreground mb-4 text-xs">
        Manage power state and gateway lifecycle.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          disabled={!isStopped || mutations.start.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_start_instance_clicked', { instance_status: status.status });
            mutations.start.mutate();
          }}
        >
          <Play className="h-4 w-4" />
          {mutations.start.isPending ? 'Starting...' : 'Start'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          disabled={!isRunning || mutations.stop.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_stop_instance_clicked', { instance_status: status.status });
            mutations.stop.mutate(undefined, {
              onSuccess: () => toast.success('Instance stopped'),
              onError: err => toast.error(err.message),
            });
          }}
        >
          <Square className="h-4 w-4" />
          {mutations.stop.isPending ? 'Stopping...' : 'Stop'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          disabled={!isRunning || mutations.restartGateway.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_restart_gateway_clicked', { instance_status: status.status });
            mutations.restartGateway.mutate(undefined, {
              onSuccess: () => toast.success('Gateway restarting'),
              onError: err => toast.error(err.message),
            });
          }}
        >
          <RotateCw className="h-4 w-4" />
          {mutations.restartGateway.isPending ? 'Restarting...' : 'Restart Gateway'}
        </Button>
      </div>
    </div>
  );
}
