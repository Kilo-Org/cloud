'use client';

import { Activity, Loader2 } from 'lucide-react';
import type { KiloClawDashboardStatus, GatewayProcessStatusResponse } from '@/lib/kiloclaw/types';
import { Badge } from '@/components/ui/badge';
import { formatTs } from './time';

const GATEWAY_STATE_STYLES: Record<
  GatewayProcessStatusResponse['state'],
  { label: string; className: string }
> = {
  running: {
    label: 'Running',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  },
  stopped: {
    label: 'Stopped',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
  starting: {
    label: 'Starting',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  },
  stopping: {
    label: 'Stopping',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  },
  crashed: {
    label: 'Crashed',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
  shutting_down: {
    label: 'Shutting Down',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400 animate-pulse',
  },
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatLastExit(lastExit: NonNullable<GatewayProcessStatusResponse['lastExit']>): string {
  const code = lastExit.code ?? 'null';
  const signal = lastExit.signal ?? 'none';
  const at = new Date(lastExit.at);
  const timeStr = at.toLocaleString();
  return `exit ${code} / ${signal} at ${timeStr}`;
}

export function InstanceTab({
  status,
  gatewayStatus,
  gatewayLoading,
  gatewayError,
}: {
  status: KiloClawDashboardStatus;
  gatewayStatus: GatewayProcessStatusResponse | undefined;
  gatewayLoading: boolean;
  gatewayError: { message: string } | null;
}) {
  const isRunning = status.status === 'running';

  if (!isRunning) {
    return (
      <p className="text-muted-foreground text-sm">
        Gateway status is available when the machine is running.
      </p>
    );
  }

  if (gatewayLoading) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">Loading gateway status...</span>
      </div>
    );
  }

  if (gatewayError) {
    const isControllerError = gatewayError.message.includes('GatewayControllerError');
    return (
      <p className="text-muted-foreground text-sm">
        {isControllerError
          ? 'Gateway control unavailable. Redeploy to update instance to use this feature.'
          : `Failed to load gateway status: ${gatewayError.message}`}
      </p>
    );
  }

  if (!gatewayStatus) return null;

  const stateStyle = GATEWAY_STATE_STYLES[gatewayStatus.state];

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-5">
      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">State</p>
        <Badge variant="outline" className={stateStyle.className}>
          <Activity className="mr-1 h-3 w-3" />
          {stateStyle.label}
        </Badge>
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">Uptime</p>
        <p className="text-foreground text-sm font-medium">{formatUptime(gatewayStatus.uptime)}</p>
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">Restarts</p>
        <p className="text-foreground text-sm font-medium">{gatewayStatus.restarts}</p>
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">Last Exit</p>
        <p className="text-muted-foreground text-sm font-medium">
          {gatewayStatus.lastExit ? formatLastExit(gatewayStatus.lastExit) : '—'}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 text-xs">Provisioned</p>
        <p className="text-foreground text-sm font-medium">{formatTs(status.provisionedAt)}</p>
      </div>
    </div>
  );
}
