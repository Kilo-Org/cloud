'use client';

import { useKiloClawStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { ExternalLink, Play, Square, RotateCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

function StatusBadge({ status }: { status: string | null }) {
  const colors: Record<string, string> = {
    running: 'bg-green-100 text-green-800',
    stopped: 'bg-red-100 text-red-800',
    provisioned: 'bg-yellow-100 text-yellow-800',
  };
  const color = status
    ? (colors[status] ?? 'bg-gray-100 text-gray-800')
    : 'bg-gray-100 text-gray-800';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {status ?? 'Not provisioned'}
    </span>
  );
}

function formatTimestamp(ts: number | null) {
  if (!ts) return 'Never';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

export default function ClawDashboardPage() {
  const { data: status, isLoading, error } = useKiloClawStatus();
  const { start, stop, restartGateway } = useKiloClawMutations();

  if (isLoading) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-2xl font-bold">KiloClaw</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-2xl font-bold">KiloClaw</h1>
        <p className="text-red-600">Failed to load status: {error.message}</p>
      </div>
    );
  }

  const isRunning = status?.status === 'running';
  const isStopped = status?.status === 'stopped';
  const isProvisioned = status?.status === 'provisioned';
  const isNotProvisioned = !status?.status;

  const baseUrl = status?.workerUrl || 'https://claw.kilo.ai';
  const clawUrl = status?.gatewayToken ? `${baseUrl}/#token=${status.gatewayToken}` : `${baseUrl}/`;

  return (
    <div className="max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">KiloClaw</h1>
        <StatusBadge status={status?.status ?? null} />
      </div>

      {/* Quick actions */}
      <div className="mb-8 flex gap-3">
        {(isStopped || isProvisioned) && (
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            <Play className="mr-2 h-4 w-4" />
            {start.isPending ? 'Starting...' : 'Start'}
          </Button>
        )}

        {isRunning && (
          <>
            <Button variant="outline" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square className="mr-2 h-4 w-4" />
              {stop.isPending ? 'Stopping...' : 'Stop'}
            </Button>
            <Button
              variant="outline"
              onClick={() => restartGateway.mutate()}
              disabled={restartGateway.isPending}
            >
              <RotateCw className="mr-2 h-4 w-4" />
              {restartGateway.isPending ? 'Restarting...' : 'Restart Gateway'}
            </Button>
            <a
              href={clawUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap"
            >
              <ExternalLink className="h-4 w-4" />
              Open
            </a>
          </>
        )}

        {isNotProvisioned && (
          <p className="text-muted-foreground text-sm">
            No instance provisioned. Configure your instance in{' '}
            <a href="/claw/settings" className="underline">
              Settings
            </a>{' '}
            to get started.
          </p>
        )}
      </div>

      {/* Instance info */}
      {status?.status && (
        <div className="space-y-4 rounded-lg border p-6">
          <h2 className="text-lg font-semibold">Instance Info</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Provisioned</span>
              <p>{formatTimestamp(status.provisionedAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last started</span>
              <p>{formatTimestamp(status.lastStartedAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last stopped</span>
              <p>{formatTimestamp(status.lastStoppedAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last sync</span>
              <p>{formatTimestamp(status.lastSyncAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Env vars</span>
              <p>{status.envVarCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Secrets</span>
              <p>{status.secretCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Channels</span>
              <p>{status.channelCount}</p>
            </div>
            {status.syncInProgress && (
              <div>
                <span className="text-muted-foreground">Sync</span>
                <p className="text-yellow-600">In progress...</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
