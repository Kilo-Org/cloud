'use client';

import { Clock, Cpu, Globe, HardDrive, Hash, Play, RotateCw, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Button } from '@/components/ui/button';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Separator } from '@/components/ui/separator';
import { DetailTile } from './DetailTile';
import { formatTs } from './time';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function InstanceTab({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const isRunning = status.status === 'running';
  const isStopped = status.status === 'stopped' || status.status === 'provisioned';
  const isDestroying = status.status === 'destroying';

  const details = [
    { label: 'Instance ID', value: 'Pending', icon: Hash, mono: true },
    { label: 'Instance Type', value: 'Not configured', icon: Cpu, mono: true },
    { label: 'Public IP', value: 'Pending', icon: Globe, mono: true },
    { label: 'Sandbox ID', value: status.sandboxId || 'N/A', icon: HardDrive, mono: true },
    { label: 'Provisioned', value: formatTs(status.provisionedAt), icon: Clock, mono: false },
    { label: 'Last Started', value: formatTs(status.lastStartedAt), icon: Clock, mono: false },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {details.map(detail => (
          <DetailTile
            key={detail.label}
            label={detail.label}
            value={detail.value}
            icon={detail.icon}
            mono={detail.mono}
          />
        ))}
      </div>

      <Separator />

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
            onClick={() => mutations.start.mutate()}
          >
            <Play className="h-4 w-4" />
            {mutations.start.isPending ? 'Starting...' : 'Start'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
            disabled={!isRunning || mutations.stop.isPending || isDestroying}
            onClick={() =>
              mutations.stop.mutate(undefined, {
                onSuccess: () => toast.success('Instance stopped'),
                onError: err => toast.error(err.message),
              })
            }
          >
            <Square className="h-4 w-4" />
            {mutations.stop.isPending ? 'Stopping...' : 'Stop'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
            disabled={!isRunning || mutations.restartGateway.isPending || isDestroying}
            onClick={() =>
              mutations.restartGateway.mutate(undefined, {
                onSuccess: () => toast.success('Gateway restarting'),
                onError: err => toast.error(err.message),
              })
            }
          >
            <RotateCw className="h-4 w-4" />
            {mutations.restartGateway.isPending ? 'Restarting...' : 'Restart Gateway'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DetailTile label="Env Vars" value={String(status.envVarCount)} icon={Hash} />
        <DetailTile label="Secrets" value={String(status.secretCount)} icon={Hash} />
        <DetailTile label="Channels" value={String(status.channelCount)} icon={Hash} />
      </div>
    </div>
  );
}
