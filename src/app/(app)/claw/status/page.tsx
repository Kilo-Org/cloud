'use client';

import {
  useKiloClawStatus,
  useKiloClawStorageInfo,
  useKiloClawMutations,
} from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { RotateCw, RefreshCw, Square, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useState } from 'react';

function formatTimestamp(ts: number | null | undefined) {
  if (!ts) return 'Never';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

export default function ClawStatusPage() {
  const { data: status, isLoading: statusLoading } = useKiloClawStatus();
  const { data: storage, isLoading: storageLoading } = useKiloClawStorageInfo();
  const { restartGateway, syncStorage, stop, destroy } = useKiloClawMutations();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  if (statusLoading || storageLoading) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-2xl font-bold">Instance Status</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!status?.status) {
    return (
      <div className="p-8">
        <h1 className="mb-4 text-2xl font-bold">Instance Status</h1>
        <p className="text-muted-foreground">No instance provisioned.</p>
      </div>
    );
  }

  const isRunning = status.status === 'running';

  return (
    <div className="max-w-3xl p-8">
      <h1 className="mb-6 text-2xl font-bold">Instance Status</h1>

      {/* Sandbox status */}
      <section className="mb-6 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">Sandbox</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Status</span>
            <p className="font-medium">{status.status}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Sandbox ID</span>
            <p className="truncate font-mono text-xs">{status.sandboxId}</p>
          </div>
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
        </div>
      </section>

      {/* R2 Storage */}
      <section className="mb-6 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">R2 Storage</h2>
        {storage && (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Configured</span>
              <p>{storage.configured ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last sync</span>
              <p>{storage.lastSync ?? 'Never'}</p>
            </div>
            {storage.syncInProgress && (
              <div className="col-span-2">
                <p className="text-sm text-yellow-600">Sync in progress...</p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Config summary */}
      <section className="mb-6 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">Configuration</h2>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Env vars</span>
            <p className="text-lg font-medium">{status.envVarCount}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Secrets</span>
            <p className="text-lg font-medium">{status.secretCount}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Channels</span>
            <p className="text-lg font-medium">{status.channelCount}</p>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">Actions</h2>
        <div className="flex flex-wrap gap-3">
          {isRunning && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  restartGateway.mutate(undefined, {
                    onSuccess: () => toast.success('Gateway restarting'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={restartGateway.isPending}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                Restart Gateway
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  syncStorage.mutate(undefined, {
                    onSuccess: () => toast.success('Sync triggered'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={syncStorage.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Force Sync
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  stop.mutate(undefined, {
                    onSuccess: () => toast.success('Instance stopped'),
                    onError: e => toast.error(e.message),
                  })
                }
                disabled={stop.isPending}
              >
                <Square className="mr-2 h-4 w-4" />
                Stop Instance
              </Button>
            </>
          )}
          {!confirmDestroy ? (
            <Button variant="destructive" onClick={() => setConfirmDestroy(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Destroy Instance
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600">Delete all data?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  destroy.mutate(
                    { deleteData: true },
                    {
                      onSuccess: () => {
                        toast.success('Instance destroyed');
                        setConfirmDestroy(false);
                      },
                      onError: e => toast.error(e.message),
                    }
                  )
                }
                disabled={destroy.isPending}
              >
                Yes, destroy
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmDestroy(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
