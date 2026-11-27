'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type SyncJob = 'metadata_cache' | 'providers' | 'direct_byok';

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function CompletedAt({
  completedAt,
  stale = false,
}: {
  completedAt: string | null | undefined;
  stale?: boolean;
}) {
  if (!completedAt) {
    return <span className="text-muted-foreground">Not recorded</span>;
  }
  const date = new Date(completedAt);
  const relative = formatDistanceToNow(date, { addSuffix: true });
  if (!stale) {
    return <span title={date.toLocaleString()}>{relative}</span>;
  }
  return (
    <span
      className="text-status-warning inline-flex items-center gap-1 font-medium"
      title={`${date.toLocaleString()}. No run has completed in over an hour, although the cron runs every 5 minutes.`}
    >
      <TriangleAlert className="text-status-warning-icon size-3.5 shrink-0" aria-hidden />
      {relative}
      <span className="sr-only"> (out of date)</span>
    </span>
  );
}

function JobRow({
  name,
  description,
  status,
  manualResult,
  run,
  stale,
}: {
  name: string;
  description: string;
  status: ReactNode;
  manualResult: string | null;
  run: { onClick: () => void; pending: boolean; disabled: boolean };
  stale: boolean;
}) {
  return (
    <TableRow className={stale ? 'bg-status-warning-surface' : undefined}>
      <TableCell className="whitespace-normal">
        <div className="font-medium">{name}</div>
        <div className="text-muted-foreground text-xs">{description}</div>
      </TableCell>
      <TableCell className="whitespace-normal">
        <div>{status}</div>
        {manualResult && <div className="text-muted-foreground text-xs">{manualResult}</div>}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={run.onClick}
            disabled={run.disabled || run.pending}
            aria-label={`Run ${name.toLowerCase()}`}
          >
            <RefreshCw className={run.pending ? 'animate-spin' : undefined} />
            {run.pending ? 'Running...' : 'Run'}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function SyncProvidersContent() {
  const trpc = useTRPC();
  const [manualResults, setManualResults] = useState<Partial<Record<SyncJob, string>>>({});
  const setManualResult = (job: SyncJob, result: string) =>
    setManualResults(previous => ({ ...previous, [job]: result }));

  const lastSyncQuery = useQuery(trpc.admin.syncProviders.getLastSync.queryOptions());
  const manualSyncEnabledQuery = useQuery(
    trpc.admin.syncProviders.getManualSyncEnabled.queryOptions()
  );
  const manualSyncDisabled = manualSyncEnabledQuery.data !== true;

  const metadataCacheRefreshMutation = useMutation(
    trpc.admin.syncProviders.triggerMetadataCacheRefresh.mutationOptions({
      onSuccess: result => {
        const refreshed = result.source_count - result.failed_count;
        setManualResult(
          'metadata_cache',
          `Manual run: ${refreshed} of ${result.source_count} sources refreshed, ${result.stale_count} over a day old`
        );
        toast.success(`Refreshed ${refreshed} of ${result.source_count} metadata sources`);
        void lastSyncQuery.refetch();
      },
      onError: error => {
        toast.error(error.message || 'Metadata cache refresh failed');
      },
    })
  );

  const syncMutation = useMutation(
    trpc.admin.syncProviders.triggerSync.mutationOptions({
      onSuccess: result => {
        setManualResult(
          'providers',
          `Manual run: ${result.total_providers} providers, ${result.total_models} models in ${formatDuration(result.time)}`
        );
        toast.success(
          `Synced ${result.total_providers} providers with ${result.total_models} total models`
        );
        void lastSyncQuery.refetch();
      },
      onError: error => {
        toast.error(error.message || 'Sync failed');
      },
    })
  );

  const directByokSyncMutation = useMutation(
    trpc.admin.syncProviders.triggerDirectByokSync.mutationOptions({
      onSuccess: result => {
        const counts = Object.entries(result.direct_byok_model_counts)
          .map(([provider, count]) => `${provider} ${count}`)
          .join(', ');
        setManualResult(
          'direct_byok',
          `Manual run: ${counts || 'no providers'} in ${formatDuration(result.time)}`
        );
        toast.success(
          `Synced ${result.total_providers} direct BYOK providers with ${result.total_models} total models`
        );
        void lastSyncQuery.refetch();
      },
      onError: error => {
        toast.error(error.message || 'Direct BYOK sync failed');
      },
    })
  );

  const lastSync = lastSyncQuery.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync jobs</CardTitle>
        <CardDescription>
          Crons run each job every 5 minutes, so manual runs are for local development
          {manualSyncEnabledQuery.data === false && ' and are disabled here'}. A job is flagged when
          it has not completed in over an hour; check Vercel logs for its errors.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <JobRow
              name="Metadata cache refresh"
              description="Stores the raw upstream catalogs that the syncs and the gateway read."
              status={
                <>
                  <CompletedAt
                    completedAt={lastSync?.metadata_cache_newest_updated_at}
                    stale={lastSync?.metadata_cache_newest_updated_stale}
                  />
                  {lastSync?.metadata_cache_oldest_updated_at && (
                    <span className="text-muted-foreground">
                      {' '}
                      · oldest source{' '}
                      <CompletedAt completedAt={lastSync.metadata_cache_oldest_updated_at} />
                    </span>
                  )}
                </>
              }
              manualResult={manualResults.metadata_cache ?? null}
              run={{
                onClick: () => metadataCacheRefreshMutation.mutate(),
                pending: metadataCacheRefreshMutation.isPending,
                disabled: manualSyncDisabled,
              }}
              stale={lastSync?.metadata_cache_newest_updated_stale ?? false}
            />
            <JobRow
              name="Provider and model sync"
              description="Builds the OpenRouter and Vercel AI Gateway provider and model catalog."
              status={
                <>
                  <CompletedAt
                    completedAt={lastSync?.completed_at}
                    stale={lastSync?.completed_stale}
                  />
                  {lastSync?.total_providers != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {lastSync.total_providers} providers, {lastSync.total_models} models
                    </span>
                  )}
                </>
              }
              manualResult={manualResults.providers ?? null}
              run={{
                onClick: () => syncMutation.mutate(),
                pending: syncMutation.isPending,
                disabled: manualSyncDisabled,
              }}
              stale={lastSync?.completed_stale ?? false}
            />
            <JobRow
              name="Direct BYOK model list sync"
              description="Stores the model list of each direct BYOK provider."
              status={
                <CompletedAt
                  completedAt={lastSync?.direct_byok_completed_at}
                  stale={lastSync?.direct_byok_completed_stale}
                />
              }
              manualResult={manualResults.direct_byok ?? null}
              run={{
                onClick: () => directByokSyncMutation.mutate(),
                pending: directByokSyncMutation.isPending,
                disabled: manualSyncDisabled,
              }}
              stale={lastSync?.direct_byok_completed_stale ?? false}
            />
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
