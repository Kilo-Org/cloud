'use client';

import {
  RefreshBenchmarkProfilesResponseSchema,
  type AutoRouter,
  type BenchmarkPair,
  type BenchmarkRegistryFailedEntry,
} from '@kilocode/auto-routing-contracts';
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { adminFetch } from '@/lib/admin/admin-fetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { parseAdminResponse } from './admin-fetch';

const QUEUE_LABELS: Record<BenchmarkRegistryFailedEntry['queues'][number], string> = {
  platform: 'Platform',
  user: 'User',
};

function failedEntryKey(entry: BenchmarkPair): string {
  return JSON.stringify([entry.model, entry.variant]);
}

function formatFailedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function nextRetryText(failure: BenchmarkRegistryFailedEntry['failure'], now: Date): string {
  if (failure.kind === 'permanent') return 'Re-admit only';
  return Date.parse(failure.retryAfter) <= now.getTime()
    ? 'Eligible now'
    : formatFailedAt(failure.retryAfter);
}

/**
 * Failed registry pairs of the live identity across both queues. Retryable ones go back
 * with "Requeue retryable" once their retry window passes; permanent ones only through
 * their own Re-admit.
 */
export function FailedModelsTable({
  entries,
  now,
  readmittingKey,
  onReadmit,
}: {
  entries: readonly BenchmarkRegistryFailedEntry[];
  now: Date;
  readmittingKey: string | null;
  onReadmit: (entry: BenchmarkPair) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No failed models</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-max">
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Variant</TableHead>
            <TableHead>Queues</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="text-right">Attempts</TableHead>
            <TableHead>First failed</TableHead>
            <TableHead>Last failed</TableHead>
            <TableHead>Next retry</TableHead>
            <TableHead>
              <span className="sr-only">Action</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(entry => {
            const key = failedEntryKey(entry);
            const { failure } = entry;
            return (
              <TableRow key={key}>
                <TableCell className="font-mono text-xs">{entry.model}</TableCell>
                <TableCell className="font-mono text-xs">{entry.variant ?? 'default'}</TableCell>
                <TableCell className="text-sm">
                  {entry.queues.map(queue => QUEUE_LABELS[queue]).join(', ')}
                </TableCell>
                <TableCell>
                  <Badge variant={failure.kind === 'permanent' ? 'destructive' : 'secondary'}>
                    {failure.kind === 'permanent' ? 'Permanent' : 'Retryable'}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{failure.failureClass}</TableCell>
                <TableCell className="max-w-md text-xs whitespace-normal">
                  {failure.reason ?? 'No reason recorded'}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {failure.attempts}
                </TableCell>
                <TableCell className="text-xs">{formatFailedAt(failure.firstFailedAt)}</TableCell>
                <TableCell className="text-xs">{formatFailedAt(failure.lastFailedAt)}</TableCell>
                <TableCell className="text-xs">{nextRetryText(failure, now)}</TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={readmittingKey !== null}
                    aria-label={`Re-admit ${entry.model} ${entry.variant ?? 'default'}`}
                    onClick={() => onReadmit({ model: entry.model, variant: entry.variant })}
                  >
                    <RotateCcw className="size-4" />
                    {readmittingKey === key ? 'Re-admitting' : 'Re-admit'}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

async function readmitFailedModel(entry: BenchmarkPair, router: AutoRouter) {
  const response = await adminFetch('/admin/api/auto-routing/benchmark-registry/readmit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ router, entry }),
  });
  return parseAdminResponse(response, RefreshBenchmarkProfilesResponseSchema);
}

export function FailedModels({
  router,
  entries,
}: {
  router: AutoRouter;
  entries: readonly BenchmarkRegistryFailedEntry[];
}) {
  const queryClient = useQueryClient();
  const readmitMutation = useMutation({
    mutationFn: (entry: BenchmarkPair) => readmitFailedModel(entry, router),
    onSuccess: (data, entry) => {
      const label = `${entry.model} (${entry.variant ?? 'default'})`;
      if (data.refreshed.length > 0) toast.success(`${label} re-admitted`);
      else if (data.unavailable.length > 0)
        toast.error(`${label} is not in the benchmark catalog, so it stays failed`);
      else toast.error(`${label} was not re-admitted: it is no longer failed or is running`);
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-registry', router],
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to re-admit the model');
    },
  });
  return (
    <FailedModelsTable
      entries={entries}
      now={new Date()}
      readmittingKey={
        readmitMutation.isPending && readmitMutation.variables
          ? failedEntryKey(readmitMutation.variables)
          : null
      }
      onReadmit={entry => readmitMutation.mutate(entry)}
    />
  );
}
