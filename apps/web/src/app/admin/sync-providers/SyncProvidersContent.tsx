'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Bell, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type SyncResult = {
  id: number;
  generated_at: string;
  completed_at?: string;
  total_providers: number;
  total_models: number;
  time: number;
};

type DirectByokSyncResult = {
  completed_at: string;
  direct_byok_model_counts: Record<string, number>;
  time: number;
};

type SyncJob = 'providers' | 'direct_byok';

function CompletedAt({ label, completedAt }: { label: string; completedAt: string | null }) {
  if (!completedAt) {
    return <p className="text-amber-500">No completed {label} timestamp recorded yet.</p>;
  }
  const date = new Date(completedAt);
  return (
    <p>
      Last {label} completed{' '}
      <span className="font-medium text-foreground" title={date.toLocaleString()}>
        {formatDistanceToNow(date, { addSuffix: true })}
      </span>{' '}
      ({date.toLocaleString()})
    </p>
  );
}

export function SyncProvidersContent() {
  const trpc = useTRPC();
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [lastDirectByokResult, setLastDirectByokResult] = useState<DirectByokSyncResult | null>(
    null
  );

  const lastSyncQuery = useQuery(trpc.admin.syncProviders.getLastSync.queryOptions());
  const manualSyncEnabledQuery = useQuery(
    trpc.admin.syncProviders.getManualSyncEnabled.queryOptions()
  );
  const manualSyncEnabled = manualSyncEnabledQuery.data === true;

  const testAlertMutation = useMutation(
    trpc.admin.syncProviders.postTestStaleAlert.mutationOptions({
      onSuccess: () => {
        toast.success('Posted a test stale-sync alert to the Cloud alerts channel');
      },
      onError: error => {
        toast.error(error.message || 'Could not post the test alert');
      },
    })
  );

  const syncMutation = useMutation(
    trpc.admin.syncProviders.triggerSync.mutationOptions({
      onSuccess: result => {
        setLastResult(result);
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
        setLastDirectByokResult(result);
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
  const postTestAlert = (job: SyncJob) => testAlertMutation.mutate({ job });
  const pendingTestAlertJob = testAlertMutation.isPending
    ? testAlertMutation.variables.job
    : undefined;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Sync Provider and Model data</h2>
      </div>

      <p className="text-muted-foreground">
        Fetches provider and model data from OpenRouter and the Vercel AI Gateway, and direct BYOK
        model lists from each direct BYOK provider, then stores the results in the database. In
        production these run automatically via separate cron jobs; the manual triggers below are
        intended for local development only.
      </p>

      {lastSync && (
        <div className="text-muted-foreground flex flex-col gap-1 text-sm">
          <CompletedAt label="full sync" completedAt={lastSync.completed_at} />
          {lastSync.generated_at && (
            <p>
              Database snapshot generated{' '}
              <span title={new Date(lastSync.generated_at).toLocaleString()}>
                {formatDistanceToNow(new Date(lastSync.generated_at), { addSuffix: true })}
              </span>{' '}
              — {lastSync.total_providers} providers, {lastSync.total_models} models.
            </p>
          )}
          <CompletedAt label="direct BYOK sync" completedAt={lastSync.direct_byok_completed_at} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Manual Sync
          </CardTitle>
          <CardDescription>
            Trigger a sync of providers and models, or of direct BYOK model lists. This may take a
            minute. Use this in local development only — production syncs are handled by cron.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => syncMutation.mutate()}
              disabled={!manualSyncEnabled || syncMutation.isPending}
              className="w-fit"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`}
              />
              {syncMutation.isPending ? 'Syncing...' : 'Run Sync'}
            </Button>
            <Button
              variant="outline"
              onClick={() => directByokSyncMutation.mutate()}
              disabled={!manualSyncEnabled || directByokSyncMutation.isPending}
              className="w-fit"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${directByokSyncMutation.isPending ? 'animate-spin' : ''}`}
              />
              {directByokSyncMutation.isPending ? 'Syncing direct BYOK...' : 'Run direct BYOK sync'}
            </Button>
          </div>
          {manualSyncEnabledQuery.data === false && (
            <p className="text-muted-foreground text-sm">
              Manual sync is disabled in production. The cron keeps provider and model data up to
              date.
            </p>
          )}

          {lastResult && (
            <div className="rounded-lg border p-4 text-sm">
              <p className="font-medium">Last sync result</p>
              <ul className="text-muted-foreground mt-2 space-y-1">
                <li>Row ID: {lastResult.id}</li>
                <li>
                  Database snapshot generated at:{' '}
                  {new Date(lastResult.generated_at).toLocaleString()}
                </li>
                {lastResult.completed_at && (
                  <li>
                    Full sync completed at: {new Date(lastResult.completed_at).toLocaleString()}
                  </li>
                )}
                <li>Providers: {lastResult.total_providers}</li>
                <li>Models: {lastResult.total_models}</li>
                <li>Duration: {(lastResult.time / 1000).toFixed(1)}s</li>
              </ul>
            </div>
          )}

          {lastDirectByokResult && (
            <div className="rounded-lg border p-4 text-sm">
              <p className="font-medium">Last direct BYOK sync result</p>
              <ul className="text-muted-foreground mt-2 space-y-1">
                <li>
                  Completed at: {new Date(lastDirectByokResult.completed_at).toLocaleString()}
                </li>
                {Object.entries(lastDirectByokResult.direct_byok_model_counts).map(
                  ([provider, count]) => (
                    <li key={provider}>
                      {provider}: {count} models
                    </li>
                  )
                )}
                <li>Duration: {(lastDirectByokResult.time / 1000).toFixed(1)}s</li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Test stale-sync alert
          </CardTitle>
          <CardDescription>
            Posts a clearly labeled test message to the Cloud alerts channel in every environment.
            Automatic stale-sync alerts still post only from production Vercel. Tests do not
            suppress later automatic alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => postTestAlert('providers')}
            disabled={testAlertMutation.isPending}
            className="w-fit"
          >
            <Bell className="h-4 w-4" />
            {pendingTestAlertJob === 'providers' ? 'Posting test alert...' : 'Post test alert'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => postTestAlert('direct_byok')}
            disabled={testAlertMutation.isPending}
            className="w-fit"
          >
            <Bell className="h-4 w-4" />
            {pendingTestAlertJob === 'direct_byok'
              ? 'Posting test alert...'
              : 'Post direct BYOK test alert'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
