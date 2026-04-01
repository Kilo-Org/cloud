'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { SafetyIdentifierCountsResponse } from '../api/safety-identifiers/route';
import type { BackfillBatchResponse } from '../api/safety-identifiers/openrouter/route';

type BatchLog = {
  provider: string;
  processed: number;
  timestamp: Date;
};

function useBackfillMutation(provider: 'openrouter' | 'vercel', onBatch: (log: BatchLog) => void) {
  const queryClient = useQueryClient();
  return useMutation<BackfillBatchResponse, Error>({
    mutationFn: async () => {
      const res = await fetch(`/admin/api/safety-identifiers/${provider}`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<BackfillBatchResponse>;
    },
    onSuccess: data => {
      onBatch({ provider, processed: data.processed, timestamp: new Date() });
      void queryClient.invalidateQueries({ queryKey: ['safety-identifier-counts'] });
    },
  });
}

type ProviderCardProps = {
  title: string;
  description: string;
  missing: number | undefined;
  isLoading: boolean;
  onBatch: (log: BatchLog) => void;
  provider: 'openrouter' | 'vercel';
};

function ProviderCard({ title, description, missing, isLoading, onBatch, provider }: ProviderCardProps) {
  const mutation = useBackfillMutation(provider, onBatch);
  const isDone = missing === 0;

  return (
    <div className="bg-background rounded-lg border p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="shrink-0">
          {isLoading ? (
            <Badge variant="secondary">Loading…</Badge>
          ) : isDone ? (
            <Badge variant="default" className="bg-green-600">All filled</Badge>
          ) : (
            <Badge variant="destructive">{(missing ?? 0).toLocaleString()} missing</Badge>
          )}
        </div>
      </div>

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{mutation.error.message}</AlertDescription>
        </Alert>
      )}

      <Button
        onClick={() => mutation.mutate()}
        disabled={isLoading || isDone || mutation.isPending}
        variant={isDone ? 'outline' : 'default'}
      >
        {mutation.isPending
          ? 'Backfilling…'
          : isDone
            ? 'Nothing to do'
            : 'Backfill next 1 000'}
      </Button>
    </div>
  );
}

export function SafetyIdentifiersBackfill() {
  const [logs, setLogs] = useState<BatchLog[]>([]);

  const { data: counts, isLoading } = useQuery<SafetyIdentifierCountsResponse>({
    queryKey: ['safety-identifier-counts'],
    queryFn: async () => {
      const res = await fetch('/admin/api/safety-identifiers');
      return res.json() as Promise<SafetyIdentifierCountsResponse>;
    },
    refetchInterval: false,
  });

  function addLog(log: BatchLog) {
    setLogs(prev => [log, ...prev]);
  }

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Backfill safety identifiers for users that were created before these fields were
        introduced. Each button processes up to 1 000 users per click. Click repeatedly
        (or rapidly) until the counter reaches zero.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ProviderCard
          provider="openrouter"
          title="OpenRouter upstream"
          description="openrouter_upstream_safety_identifier — sent to OpenRouter with every request so they can trace abuse back to a Kilo user."
          missing={counts?.openrouterMissing}
          isLoading={isLoading}
          onBatch={addLog}
        />
        <ProviderCard
          provider="vercel"
          title="Vercel downstream"
          description="vercel_downstream_safety_identifier — sent to the Vercel AI Gateway so Vercel can correlate requests to a Kilo user."
          missing={counts?.vercelMissing}
          isLoading={isLoading}
          onBatch={addLog}
        />
      </div>

      {logs.length > 0 && (
        <div className="bg-background rounded-lg border p-4 space-y-2">
          <h4 className="text-sm font-medium">Batch log</h4>
          <div className="space-y-1 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className="text-muted-foreground flex gap-2">
                <span className="shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                <span className="shrink-0 font-medium text-foreground">[{log.provider}]</span>
                <span>processed {log.processed.toLocaleString()} users</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
