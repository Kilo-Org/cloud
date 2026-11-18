'use client';

import { adminFetch } from '@/lib/admin/admin-fetch';

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

  const {
    data: counts,
    isLoading,
    error,
  } = useQuery<SafetyIdentifierCountsResponse>({
    queryKey: ['safety-identifier-counts'],
    queryFn: async () => {
      const res = await adminFetch('/admin/api/safety-identifiers');
      if (!res.ok) {
        throw new Error(`Could not load backfill status (HTTP ${res.status})`);
      }
      return res.json() as Promise<SafetyIdentifierCountsResponse>;
    },
    refetchInterval: false,
  });

  const mutation = useMutation<BackfillBatchResponse, Error>({
    mutationFn: async () => {
      const res = await adminFetch('/admin/api/safety-identifiers', { method: 'POST' });
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
        Fill in OpenRouter and Vercel safety identifiers for users missing any of them. Existing
        identifiers are never changed. Each click processes up to 50 000 users.
      </p>

      <div className="bg-background space-y-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <span className="font-medium">Users missing a safety identifier</span>
          {isLoading ? (
            <Badge variant="secondary">Loading...</Badge>
          ) : !counts ? (
            <Badge variant="destructive">Status unavailable</Badge>
          ) : isDone ? (
            <Badge variant="default" className="bg-green-600">
              All filled
            </Badge>
          ) : (
            <Badge variant="destructive">{counts.missing.toLocaleString()} missing</Badge>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {mutation.isError && (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={() => mutation.mutate()}
          disabled={!counts || isDone || mutation.isPending}
          variant={isDone ? 'outline' : 'default'}
        >
          {mutation.isPending
            ? 'Backfilling...'
            : isDone
              ? 'Nothing to do'
              : 'Backfill next 50 000'}
        </Button>
      </div>

      {logs.length > 0 && (
        <div className="bg-background space-y-2 rounded-lg border p-4">
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
