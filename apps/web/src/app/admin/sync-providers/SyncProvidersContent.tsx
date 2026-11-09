'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Bell, RefreshCw } from 'lucide-react';
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

function CompletedAt({ completedAt }: { completedAt: string | null | undefined }) {
  if (!completedAt) {
    return <span className="text-muted-foreground">Not recorded</span>;
  }
  const date = new Date(completedAt);
  return (
    <span title={date.toLocaleString()}>{formatDistanceToNow(date, { addSuffix: true })}</span>
  );
}

function JobRow({
  name,
  description,
  status,
  manualResult,
  run,
  testAlert,
}: {
  name: string;
  description: string;
  status: ReactNode;
  manualResult: string | null;
  run: { onClick: () => void; pending: boolean; disabled: boolean };
  testAlert: { onClick: () => void; pending: boolean; disabled: boolean };
}) {
  return (
    <TableRow>
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
          <Button
            size="sm"
            variant="outline"
            onClick={testAlert.onClick}
            disabled={testAlert.disabled}
            aria-label={`Post test alert for ${name.toLowerCase()}`}
          >
            <Bell />
            {testAlert.pending ? 'Posting...' : 'Test alert'}
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

  const testAlertMutation = useMutation(
    trpc.admin.syncProviders.postTestStaleAlert.mutationOptions({
      onSuccess: () => {
        toast.success('Posted a test alert to the Cloud alerts channel');
      },
      onError: error => {
        toast.error(error.message || 'Could not post the test alert');
      },
    })
  );

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
  const pendingTestAlertJob = testAlertMutation.isPending
    ? testAlertMutation.variables.job
    : undefined;
  const testAlert = (job: SyncJob) => ({
    onClick: () => testAlertMutation.mutate({ job }),
    pending: pendingTestAlertJob === job,
    disabled: testAlertMutation.isPending,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync jobs</CardTitle>
        <CardDescription>
          Crons run each job every 5 minutes, so manual runs are for local development
          {manualSyncEnabledQuery.data === false && ' and are disabled here'}. Test alerts post a
          labeled message to the Cloud alerts channel from any environment; real stale alerts post
          only from production.
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
                  <CompletedAt completedAt={lastSync?.metadata_cache_newest_updated_at} />
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
              testAlert={testAlert('metadata_cache')}
            />
            <JobRow
              name="Provider and model sync"
              description="Builds the OpenRouter and Vercel AI Gateway provider and model catalog."
              status={
                <>
                  <CompletedAt completedAt={lastSync?.completed_at} />
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
              testAlert={testAlert('providers')}
            />
            <JobRow
              name="Direct BYOK model list sync"
              description="Stores the model list of each direct BYOK provider."
              status={<CompletedAt completedAt={lastSync?.direct_byok_completed_at} />}
              manualResult={manualResults.direct_byok ?? null}
              run={{
                onClick: () => directByokSyncMutation.mutate(),
                pending: directByokSyncMutation.isPending,
                disabled: manualSyncDisabled,
              }}
              testAlert={testAlert('direct_byok')}
            />
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
