'use client';

import { useState, useEffect } from 'react';
import { Cpu, HardDrive, Play, RefreshCw, RotateCw, Stethoscope } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { RunDoctorDialog } from './RunDoctorDialog';

const VOLUME_SIZE_GB = 10;
// Default machine spec fallback (matches kiloclaw DEFAULT_MACHINE_GUEST)
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 3072;

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount(c => (c % 3) + 1), 500);
    return () => clearInterval(id);
  }, []);
  // Pad with invisible characters to keep width constant
  const visible = '.'.repeat(count);
  const hidden = '.'.repeat(3 - count);
  return (
    <span>
      {visible}
      <span className="invisible">{hidden}</span>
    </span>
  );
}

export function InstanceControls({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const posthog = usePostHog();
  const isRunning = status.status === 'running';
  const isProvisioned = status.status === 'provisioned';
  const isStopped = status.status === 'stopped' || isProvisioned;
  const isDestroying = status.status === 'destroying';
  // Auto-start runs only on fresh provision (status=provisioned), not re-provision
  const isAutoStarting = isProvisioned && mutations.provision.isPending;
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-foreground mb-1 text-sm font-medium">Instance Controls</h3>
          <p className="text-muted-foreground text-xs">Manage power state and gateway lifecycle.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
            <Cpu className="h-3.5 w-3.5" />
            {status.machineSize?.cpus ?? DEFAULT_CPUS} vCPU,{' '}
            {formatMemory(status.machineSize?.memory_mb ?? DEFAULT_MEMORY_MB)} RAM
          </Badge>
          <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
            <HardDrive className="h-3.5 w-3.5" />
            {VOLUME_SIZE_GB} GB SSD
          </Badge>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          disabled={!isStopped || mutations.start.isPending || isAutoStarting || isDestroying}
          onClick={() => {
            posthog?.capture('claw_start_instance_clicked', { instance_status: status.status });
            mutations.start.mutate();
          }}
        >
          <Play className="h-4 w-4" />
          {mutations.start.isPending || isAutoStarting ? (
            <>
              Starting
              <AnimatedDots />
            </>
          ) : (
            'Start Machine'
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
          disabled={!isRunning || mutations.restartOpenClaw.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_restart_openclaw_prompted', {
              instance_status: status.status,
            });
            setConfirmRestart(true);
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Restart OpenClaw
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          disabled={!isRunning || mutations.restartGateway.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_redeploy_prompted', { instance_status: status.status });
            setConfirmRedeploy(true);
          }}
        >
          <RotateCw className="h-4 w-4" />
          Redeploy
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300"
          disabled={!isRunning || mutations.runDoctor.isPending || isDestroying}
          onClick={() => {
            posthog?.capture('claw_doctor_clicked', { instance_status: status.status });
            setDoctorOpen(true);
          }}
        >
          <Stethoscope className="h-4 w-4" />
          OpenClaw Doctor
        </Button>
      </div>
      <ConfirmActionDialog
        open={confirmRestart}
        onOpenChange={open => {
          if (!open) posthog?.capture('claw_restart_openclaw_cancelled');
          setConfirmRestart(open);
        }}
        title="Restart OpenClaw"
        description="This will restart the gateway process inside the running machine. Active sessions will be briefly interrupted and reconnect automatically."
        confirmLabel="Restart"
        confirmIcon={<RefreshCw className="h-4 w-4" />}
        isPending={mutations.restartOpenClaw.isPending}
        pendingLabel="Restarting..."
        className="border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300"
        onConfirm={() => {
          posthog?.capture('claw_restart_openclaw_clicked', {
            instance_status: status.status,
          });
          mutations.restartOpenClaw.mutate(undefined, {
            onSuccess: () => {
              toast.success('OpenClaw restarting');
              setConfirmRestart(false);
            },
            onError: err => toast.error(err.message),
          });
        }}
      />
      <ConfirmActionDialog
        open={confirmRedeploy}
        onOpenChange={open => {
          if (!open) posthog?.capture('claw_redeploy_cancelled');
          setConfirmRedeploy(open);
        }}
        title="Redeploy Gateway"
        description="This will stop the machine, rebuild environment variables and secrets, apply any pending image updates, and restart it. The machine will be briefly offline."
        confirmLabel="Redeploy"
        confirmIcon={<RotateCw className="h-4 w-4" />}
        isPending={mutations.restartGateway.isPending}
        pendingLabel="Redeploying..."
        className="border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
        onConfirm={() => {
          posthog?.capture('claw_redeploy_clicked', { instance_status: status.status });
          mutations.restartGateway.mutate(undefined, {
            onSuccess: () => {
              toast.success('Gateway restarting');
              setConfirmRedeploy(false);
            },
            onError: err => toast.error(err.message),
          });
        }}
      />
      <RunDoctorDialog
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        mutation={mutations.runDoctor}
      />
    </div>
  );
}
