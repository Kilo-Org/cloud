'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type {
  BlockBlacklistedDomainsCountsResponse,
  BlockBlacklistedDomainsBackfillResponse,
} from '../api/backfills/block-blacklisted-domains/route';

type BatchLog = {
  processed: number;
  timestamp: Date;
};

export function BlockBlacklistedDomainsBackfill() {
  const [logs, setLogs] = useState<BatchLog[]>([]);
  const queryClient = useQueryClient();

  const { data: counts, isLoading } = useQuery<BlockBlacklistedDomainsCountsResponse>({
    queryKey: ['block-blacklisted-domains-counts'],
    queryFn: async () => {
      const res = await fetch('/admin/api/backfills/block-blacklisted-domains');
      return res.json() as Promise<BlockBlacklistedDomainsCountsResponse>;
    },
    refetchInterval: false,
  });

  const mutation = useMutation<BlockBlacklistedDomainsBackfillResponse, Error>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/backfills/block-blacklisted-domains', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<BlockBlacklistedDomainsBackfillResponse>;
    },
    onSuccess: data => {
      setLogs(prev => [{ processed: data.processed, timestamp: new Date() }, ...prev]);
      void queryClient.invalidateQueries({
        queryKey: ['block-blacklisted-domains-counts'],
      });
    },
  });

  const isDone = counts?.unblocked === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Block users whose email matches a blacklisted domain but who don&apos;t yet have a
        blocked_reason set. Each click processes up to 50 000 users. Click repeatedly until the
        counter reaches zero.
      </p>

      <div className="bg-background space-y-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <span className="font-medium">Unblocked users on blacklisted domains</span>
          {isLoading ? (
            <Badge variant="secondary">Loading...</Badge>
          ) : isDone ? (
            <Badge variant="default" className="bg-green-600">
              All blocked
            </Badge>
          ) : (
            <Badge variant="destructive">
              {(counts?.unblocked ?? 0).toLocaleString()} unblocked
            </Badge>
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
          {mutation.isPending ? 'Blocking...' : isDone ? 'Nothing to do' : 'Block next 50 000'}
        </Button>
      </div>

      {logs.length > 0 && (
        <div className="bg-background space-y-2 rounded-lg border p-4">
          <h4 className="text-sm font-medium">Batch log</h4>
          <div className="space-y-1 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className="text-muted-foreground flex gap-2">
                <span className="shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                <span>blocked {log.processed.toLocaleString()} users</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
