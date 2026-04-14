'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, HardDrive, Loader2, RotateCcw, TimerReset } from 'lucide-react';
import type { AnalyticsEngineResponse, ControllerTelemetryRow } from '@/lib/kiloclaw/disk-usage';
import type { KiloClawDashboardStatus, GatewayProcessStatusResponse } from '@/lib/kiloclaw/types';
import { Badge } from '@/components/ui/badge';
import {
  formatUptime,
  formatVolumeUsage,
  getVolumeBarColor,
  getVolumeUsagePercent,
} from '@/lib/kiloclaw/instance-display';
import { formatTs } from './time';
import { useClawContext } from './ClawContext';

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

function formatLastExit(lastExit: NonNullable<GatewayProcessStatusResponse['lastExit']>): string {
  const code = lastExit.code ?? 'null';
  const signal = lastExit.signal ?? 'none';
  const at = new Date(lastExit.at);
  const timeStr = at.toLocaleString();
  return `exit ${code} / ${signal} at ${timeStr}`;
}

export function diskUsageQueryKey(organizationId: string | undefined) {
  return ['kiloclaw', 'disk-usage', organizationId ?? 'personal'] as const;
}

export function hasVolumeUsageData(diskUsed: number | null, diskTotal: number | null) {
  return diskUsed !== null && diskTotal !== null;
}

function useDiskUsage(enabled: boolean, organizationId: string | undefined) {
  return useQuery<AnalyticsEngineResponse<ControllerTelemetryRow>>({
    queryKey: diskUsageQueryKey(organizationId),
    queryFn: async () => {
      const response = await fetch('/api/kiloclaw/disk-usage');
      if (!response.ok) {
        throw new Error('Failed to fetch disk usage');
      }
      return response.json() as Promise<AnalyticsEngineResponse<ControllerTelemetryRow>>;
    },
    enabled,
    refetchInterval: 60_000,
  });
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
  gatewayError: { message: string; data?: { code?: string } | null } | null;
}) {
  const { organizationId } = useClawContext();
  const isRunning = status.status === 'running';
  const diskUsage = useDiskUsage(isRunning, organizationId);
  const diskUsageRow = diskUsage.data?.data?.[0];
  const diskUsed =
    diskUsageRow && diskUsageRow.disk_used_bytes > 0 ? diskUsageRow.disk_used_bytes : null;
  const diskTotal =
    diskUsageRow && diskUsageRow.disk_total_bytes > 0 ? diskUsageRow.disk_total_bytes : null;
  const diskUsagePercent = getVolumeUsagePercent(diskUsed, diskTotal);

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
    const isControllerUnavailable = gatewayError.data?.code === 'NOT_FOUND';
    return (
      <p className="text-muted-foreground text-sm">
        {isControllerUnavailable
          ? 'Gateway control unavailable. Redeploy to update instance to use this feature.'
          : 'Failed to load gateway status.'}
      </p>
    );
  }

  if (!gatewayStatus) return null;

  const stateStyle = GATEWAY_STATE_STYLES[gatewayStatus.state];

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">State</p>
        <div className="mt-2">
          <Badge variant="outline" className={stateStyle.className}>
            <Activity className="mr-1 h-3 w-3" />
            {stateStyle.label}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-5 text-xs font-medium uppercase tracking-wide">
          Uptime
        </p>
        <p className="text-foreground mt-2 text-lg font-semibold leading-none">
          {formatUptime(gatewayStatus.uptime)}
        </p>
      </div>

      {hasVolumeUsageData(diskUsed, diskTotal) && (
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <HardDrive className="text-muted-foreground h-4 w-4" />
            <p className="text-foreground text-sm font-medium">Volume Usage</p>
          </div>
          <p className="text-foreground text-sm font-semibold">
            {formatVolumeUsage(diskUsed, diskTotal)}
          </p>
          <div className="bg-muted mt-3 h-2 overflow-hidden rounded-full">
            <div
              className={`h-full rounded-full ${getVolumeBarColor(diskUsagePercent)} transition-all`}
              style={{ width: `${diskUsagePercent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center gap-2">
          <TimerReset className="text-muted-foreground h-4 w-4" />
          <p className="text-foreground text-sm font-medium">Lifecycle</p>
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground inline-flex items-center gap-2">
              <RotateCcw className="h-3.5 w-3.5" />
              Restarts
            </span>
            <span className="text-foreground font-medium">{gatewayStatus.restarts}</span>
          </div>
          <div className="flex items-start justify-between gap-3 text-sm">
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-2">
              <TimerReset className="h-3.5 w-3.5" />
              Last Exit
            </span>
            <span className="text-muted-foreground min-w-0 text-right font-medium break-words">
              {gatewayStatus.lastExit ? formatLastExit(gatewayStatus.lastExit) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground inline-flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" />
              Provisioned
            </span>
            <span className="text-foreground min-w-0 truncate text-right font-medium">
              {formatTs(status.provisionedAt)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
