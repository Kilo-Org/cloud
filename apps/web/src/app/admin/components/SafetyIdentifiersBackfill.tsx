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
  processed: number;
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
      setLogs(prev => [{ processed: data.processed, timestamp: new Date() }, ...prev]);
      void queryClient.invalidateQueries({ queryKey: ['safety-identifier-counts'] });
    },
  });

  const isDone = counts?.missing === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Backfill safety identifiers for users missing either field. Each click processes up to 50
        000 users (50 batches of 1 000). Click repeatedly until the counter reaches zero.
      </p>

      <div className="bg-background rounded-lg border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <span className="font-medium">Users missing a safety identifier</span>
          {isLoading ? (
            <Badge variant="secondary">Loading…</Badge>
          ) : isDone ? (
            <Badge variant="default" className="bg-green-600">
              All filled
            </Badge>
          ) : (
            <Badge variant="destructive">{(counts?.missing ?? 0).toLocaleString()} missing</Badge>
          )}
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
          {mutation.isPending ? 'Backfilling…' : isDone ? 'Nothing to do' : 'Backfill next 50 000'}
        </Button>
      </div>

      {logs.length > 0 && (
        <div className="bg-background rounded-lg border p-4 space-y-2">
          <h4 className="text-sm font-medium">Batch log</h4>
          <div className="space-y-1 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className="text-muted-foreground flex gap-2">
                <span className="shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                <span>processed {log.processed.toLocaleString()} users</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
