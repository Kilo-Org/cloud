'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type SyncResult = {
  id: number;
  generated_at: string;
  total_providers: number;
  total_models: number;
  time: number;
};

export function SyncProvidersContent() {
  const trpc = useTRPC();
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const syncMutation = useMutation(
    trpc.admin.syncProviders.triggerSync.mutationOptions({
      onSuccess: result => {
        setLastResult(result);
        toast.success(
          `Synced ${result.total_providers} providers with ${result.total_models} total models`
        );
      },
      onError: error => {
        toast.error(error.message || 'Sync failed');
      },
    })
  );

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Sync Provider and Model data</h2>
      </div>

      <p className="text-muted-foreground">
        Fetches provider and model data from OpenRouter and the Vercel AI Gateway, then stores the
        result in the database. This runs automatically via cron but can be triggered manually here.
        Mainly intended for local development use.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Manual Sync
          </CardTitle>
          <CardDescription>
            Trigger a full sync of providers and models. This may take a minute.
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
                <li>Generated at: {new Date(lastResult.generated_at).toLocaleString()}</li>
                <li>Providers: {lastResult.total_providers}</li>
                <li>Models: {lastResult.total_models}</li>
                <li>Duration: {(lastResult.time / 1000).toFixed(1)}s</li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
