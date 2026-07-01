'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type {
  BlockedUserPepperCountsResponse,
  BlockedUserPepperBackfillResponse,
} from '../api/backfills/blocked-user-pepper/route';

type BatchLog = {
  processed: number;
  timestamp: Date;
};

export function BlockedUserPepperBackfill() {
  const [logs, setLogs] = useState<BatchLog[]>([]);
  const queryClient = useQueryClient();

  const { data: counts, isLoading } = useQuery<BlockedUserPepperCountsResponse>({
    queryKey: ['blocked-user-pepper-counts'],
    queryFn: async () => {
      const res = await fetch('/admin/api/backfills/blocked-user-pepper');
      return res.json() as Promise<BlockedUserPepperCountsResponse>;
    },
    refetchInterval: false,
  });

  const mutation = useMutation<BlockedUserPepperBackfillResponse, Error>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/backfills/blocked-user-pepper', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<BlockedUserPepperBackfillResponse>;
    },
    onSuccess: data => {
      setLogs(prev => [{ processed: data.processed, timestamp: new Date() }, ...prev]);
      void queryClient.invalidateQueries({ queryKey: ['blocked-user-pepper-counts'] });
    },
  });

  const isDone = counts?.missing === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Assign a fresh api_token_pepper to blocked users who have never had one. Their existing API
        and device tokens carry a null pepper, which the pepper check treats as &quot;no
        revocation&quot;, so those tokens stay valid even though the user is blocked. Users with a
        non-null pepper are excluded because that value already reflects a prior rotation (block,
        admin reset, or soft delete).
      </p>

      <div className="bg-background space-y-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <span className="font-medium">Blocked users with a null pepper</span>
          {isLoading ? (
            <Badge variant="secondary">Loading...</Badge>
          ) : isDone ? (
            <Badge variant="default" className="bg-green-600">
              All rotated
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
                <span>rotated {log.processed.toLocaleString()} users</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
