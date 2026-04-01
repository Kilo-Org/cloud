'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type {
  SafetyIdentifierCountsResponse,
  BackfillBatchResponse,
} from '../api/safety-identifiers/route';

type BatchLog = {
  openrouterProcessed: number;
  vercelProcessed: number;
  timestamp: Date;
};

export function SafetyIdentifiersBackfill() {
  const [logs, setLogs] = useState<BatchLog[]>([]);
  const queryClient = useQueryClient();

  const { data: counts, isLoading } = useQuery<SafetyIdentifierCountsResponse>({
    queryKey: ['safety-identifier-counts'],
    queryFn: async () => {
      const res = await fetch('/admin/api/safety-identifiers');
      return res.json() as Promise<SafetyIdentifierCountsResponse>;
    },
    refetchInterval: false,
  });

  const mutation = useMutation<BackfillBatchResponse, Error>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/safety-identifiers', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<BackfillBatchResponse>;
    },
    onSuccess: data => {
      setLogs(prev => [
        { openrouterProcessed: data.openrouterProcessed, vercelProcessed: data.vercelProcessed, timestamp: new Date() },
        ...prev,
      ]);
      void queryClient.invalidateQueries({ queryKey: ['safety-identifier-counts'] });
    },
  });

  const isDone = counts?.openrouterMissing === 0 && counts?.vercelMissing === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Backfill safety identifiers for users created before these fields were introduced.
        Each click processes up to 1 000 users per provider simultaneously. Click repeatedly
        until both counters reach zero.
      </p>

      <div className="bg-background rounded-lg border p-6 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">OpenRouter upstream</span>
              {isLoading ? (
                <Badge variant="secondary">Loading…</Badge>
              ) : counts?.openrouterMissing === 0 ? (
                <Badge variant="default" className="bg-green-600">All filled</Badge>
              ) : (
                <Badge variant="destructive">{(counts?.openrouterMissing ?? 0).toLocaleString()} missing</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              openrouter_upstream_safety_identifier
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Vercel downstream</span>
              {isLoading ? (
                <Badge variant="secondary">Loading…</Badge>
              ) : counts?.vercelMissing === 0 ? (
                <Badge variant="default" className="bg-green-600">All filled</Badge>
              ) : (
                <Badge variant="destructive">{(counts?.vercelMissing ?? 0).toLocaleString()} missing</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              vercel_downstream_safety_identifier
            </p>
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

      {logs.length > 0 && (
        <div className="bg-background rounded-lg border p-4 space-y-2">
          <h4 className="text-sm font-medium">Batch log</h4>
          <div className="space-y-1 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className="text-muted-foreground flex gap-2">
                <span className="shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                <span>
                  openrouter: {log.openrouterProcessed.toLocaleString()}, vercel: {log.vercelProcessed.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
