'use client';

import { adminFetch } from '@/lib/admin/admin-fetch';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type {
  SafetyIdentifierStatusResponse,
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
    data: status,
    isLoading,
    error,
  } = useQuery<SafetyIdentifierStatusResponse>({
    queryKey: ['safety-identifier-status'],
    queryFn: async () => {
      const res = await adminFetch('/admin/api/safety-identifiers');
      if (!res.ok) {
        throw new Error(`Could not load backfill status (HTTP ${res.status})`);
      }
      return res.json() as Promise<SafetyIdentifierStatusResponse>;
    },
    refetchInterval: 15_000,
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
      setLogs(prev => [{ processed: data.processed, timestamp: new Date() }, ...prev].slice(0, 20));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['safety-identifier-status'] });
    },
  });

  const backfill = status?.backfill;
  const isDone = backfill?.status === 'completed';
  const isRunning = status?.running || mutation.isPending;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Regenerate all OpenRouter and Vercel safety identifiers, including existing values.
        Scheduled batches resume from the last saved account. You can also run a batch manually for
        development.
      </p>

      <div className="bg-background rounded-lg border p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3" role="status">
          <span className="font-medium">Safety identifier regeneration</span>
          {isLoading ? (
            <Badge variant="secondary">Loading...</Badge>
          ) : !status ? (
            <Badge variant="destructive">Status unavailable</Badge>
          ) : isDone ? (
            <Badge variant="secondary">Completed</Badge>
          ) : isRunning ? (
            <Badge variant="secondary">Batch running</Badge>
          ) : backfill?.status === 'pending' ? (
            <Badge variant="outline">Not started</Badge>
          ) : (
            <Badge variant="outline">Waiting for next batch</Badge>
          )}
        </div>

        {status && backfill && (
          <>
            <p className="text-muted-foreground text-sm">
              Up to {status.batchSize.toLocaleString()} accounts every {status.scheduleMinutes}{' '}
              minutes. Status refreshes every 15 seconds.
            </p>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Accounts regenerated</dt>
                <dd className="font-mono tabular-nums">
                  {backfill.processed.toLocaleString()}
                  {backfill.total !== null && ` / ${backfill.total.toLocaleString()}`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Started at</dt>
                <dd>
                  {backfill.startedAt
                    ? new Date(backfill.startedAt).toLocaleString()
                    : 'Not started'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last checkpoint</dt>
                <dd>
                  {backfill.updatedAt
                    ? new Date(backfill.updatedAt).toLocaleString()
                    : 'Not started'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last batch</dt>
                <dd className="font-mono tabular-nums">
                  {backfill.lastBatchProcessed.toLocaleString()} accounts
                </dd>
              </div>
              {backfill.cursor !== null && (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-muted-foreground">Last saved account</dt>
                  <dd className="font-mono break-all">{backfill.cursor}</dd>
                </div>
              )}
              {backfill.completedAt && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Completed at</dt>
                  <dd>{new Date(backfill.completedAt).toLocaleString()}</dd>
                </div>
              )}
            </dl>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {backfill?.lastError && (
          <Alert variant="destructive">
            <AlertDescription>{backfill.lastError}</AlertDescription>
          </Alert>
        )}

        {mutation.isError && (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={() => mutation.mutate()}
          disabled={!status || isDone || isRunning}
          variant={isDone ? 'outline' : 'default'}
          className="min-h-11 w-full sm:w-auto"
        >
          {isRunning ? 'Batch running...' : isDone ? 'Regeneration complete' : 'Run next batch'}
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
