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
  direct_byok_model_counts: Record<string, number>;
  time: number;
};

export function SyncProvidersContent() {
  const trpc = useTRPC();
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const lastSyncQuery = useQuery(trpc.admin.syncProviders.getLastSync.queryOptions());

  const testAlertMutation = useMutation(
    trpc.admin.syncProviders.postTestStaleAlert.mutationOptions({
      onSuccess: result => {
        toast.success(
          result.delivery === 'posted'
            ? 'Posted a test stale-sync alert to the Cloud alerts channel'
            : 'Simulated the test alert in the local server logs'
        );
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

  const lastSync = lastSyncQuery.data;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Sync Provider and Model data</h2>
      </div>

      <p className="text-muted-foreground">
        Fetches provider and model data from OpenRouter and the Vercel AI Gateway, then stores the
        result in the database. In production this runs automatically via cron; the manual trigger
        below is intended for local development only.
      </p>

      {lastSync && (
        <div className="text-muted-foreground flex flex-col gap-1 text-sm">
          {lastSync.completed_at ? (
            <p>
              Last full sync completed{' '}
              <span
                className="font-medium text-foreground"
                title={new Date(lastSync.completed_at).toLocaleString()}
              >
                {formatDistanceToNow(new Date(lastSync.completed_at), { addSuffix: true })}
              </span>{' '}
              ({new Date(lastSync.completed_at).toLocaleString()})
            </p>
          ) : (
            <p className="text-amber-500">No completed full run timestamp recorded in Redis yet.</p>
          )}
          {lastSync.generated_at && (
            <p>
              Database snapshot generated{' '}
              <span title={new Date(lastSync.generated_at).toLocaleString()}>
                {formatDistanceToNow(new Date(lastSync.generated_at), { addSuffix: true })}
              </span>{' '}
              — {lastSync.total_providers} providers, {lastSync.total_models} models.
            </p>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Manual Sync
          </CardTitle>
          <CardDescription>
            Trigger a full sync of providers and models. This may take a minute. Use this in local
            development only — production syncs are handled by cron.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="w-fit"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            {syncMutation.isPending ? 'Syncing...' : 'Run Sync'}
          </Button>

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
                {Object.entries(lastResult.direct_byok_model_counts).map(([provider, count]) => (
                  <li key={provider}>
                    Direct BYOK {provider}: {count} models
                  </li>
                ))}
                <li>Duration: {(lastResult.time / 1000).toFixed(1)}s</li>
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
            Production Vercel posts a clearly labeled test message to the Cloud alerts channel.
            Local and preview environments log the same payload without contacting Slack. Tests do
            not suppress later real alerts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => testAlertMutation.mutate()}
            disabled={testAlertMutation.isPending}
            className="w-fit"
          >
            <Bell className="h-4 w-4" />
            {testAlertMutation.isPending ? 'Posting test alert...' : 'Post test alert'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
