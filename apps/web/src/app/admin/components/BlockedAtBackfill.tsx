'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type {
  BlockedAtCountsResponse,
  BlockedAtBackfillResponse,
} from '../api/backfills/blocked-at/route';

type BatchLog = {
  processed: number;
  timestamp: Date;
};

export function BlockedAtBackfill() {
  const [logs, setLogs] = useState<BatchLog[]>([]);
  const queryClient = useQueryClient();

  const { data: counts, isLoading } = useQuery<BlockedAtCountsResponse>({
    queryKey: ['blocked-at-counts'],
    queryFn: async () => {
      const res = await fetch('/admin/api/backfills/blocked-at');
      return res.json() as Promise<BlockedAtCountsResponse>;
    },
    refetchInterval: false,
  });

  const mutation = useMutation<BlockedAtBackfillResponse, Error>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/backfills/blocked-at', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<BlockedAtBackfillResponse>;
    },
    onSuccess: data => {
      setLogs(prev => [{ processed: data.processed, timestamp: new Date() }, ...prev]);
      void queryClient.invalidateQueries({ queryKey: ['blocked-at-counts'] });
    },
  });

  const isDone = counts?.missing === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Backfill block timestamps for users who already have a blocked reason but no blocked_at.
        This uses each row&apos;s current updated_at as the best available historical approximation.
        Soft-deleted users are excluded. The blocker remains unknown for historical rows because
        there is no reliable system user to attribute the original action to.
      </p>

      <div className="bg-background space-y-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <span className="font-medium">Blocked users missing blocked_at</span>
          {isLoading ? (
            <Badge variant="secondary">Loading...</Badge>
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
                <span>backfilled {log.processed.toLocaleString()} users</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
