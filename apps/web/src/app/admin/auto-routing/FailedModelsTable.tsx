'use client';

import {
  RefreshBenchmarkProfilesResponseSchema,
  type AutoRouter,
  type BenchmarkPair,
  type BenchmarkRegistryFailedEntry,
  type RefreshBenchmarkProfilesResponse,
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
import { AdminTimeLabel } from './AdminTimeLabel';
import { formatAdminTime } from './admin-time';

const QUEUE_LABELS: Record<BenchmarkRegistryFailedEntry['queues'][number], string> = {
  platform: 'Platform',
  user: 'User',
};

function failedEntryKey(entry: BenchmarkPair): string {
  return JSON.stringify([entry.model, entry.variant]);
}

function nextRetryText(failure: BenchmarkRegistryFailedEntry['failure'], now: Date): string {
  if (failure.kind === 'permanent') return 'Re-admit only';
  return Date.parse(failure.retryAfter) <= now.getTime()
    ? 'Eligible now'
    : formatAdminTime(failure.retryAfter, now.getTime()).local;
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Failed</TableHead>
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
            const reason = failure.reason ?? 'No reason recorded';
            return (
              <TableRow key={key}>
                <TableCell className="max-w-64">
                  <div className="font-mono text-xs break-all">{entry.model}</div>
                  <div className="text-muted-foreground text-xs">
                    <span className="font-mono">{entry.variant ?? 'default'}</span> ·{' '}
                    {entry.queues.map(queue => QUEUE_LABELS[queue]).join(', ')}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={failure.kind === 'permanent' ? 'destructive' : 'secondary'}>
                    {failure.kind === 'permanent' ? 'Permanent' : 'Retryable'}
                  </Badge>
                  <div className="text-muted-foreground mt-1 font-mono text-xs">
                    {failure.failureClass}
                  </div>
                </TableCell>
                <TableCell className="min-w-48 max-w-96 text-xs">
                  <p className="break-words whitespace-pre-wrap" title={reason}>
                    {reason}
                  </p>
                </TableCell>
                <TableCell className="text-xs">
                  <div>
                    <span className="text-muted-foreground">First </span>
                    <AdminTimeLabel iso={failure.firstFailedAt} now={now.getTime()} />
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground">Last </span>
                    <AdminTimeLabel iso={failure.lastFailedAt} now={now.getTime()} />
                    <span className="text-muted-foreground">
                      {' '}
                      · {failure.attempts} {failure.attempts === 1 ? 'attempt' : 'attempts'}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-xs">{nextRetryText(failure, now)}</TableCell>
                <TableCell className="text-right">
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

/** The toast for a re-admit response, naming the drain's reason when the pair was refused. */
export function readmitOutcome(
  data: RefreshBenchmarkProfilesResponse,
  entry: BenchmarkPair
): { kind: 'success' | 'error'; message: string } {
  const label = `${entry.model} (${entry.variant ?? 'default'})`;
  if (data.refreshed.length > 0) return { kind: 'success', message: `${label} re-admitted` };
  if (data.unavailable.length > 0) {
    const refusal = data.refusals?.find(
      refused => refused.entry.model === entry.model && refused.entry.variant === entry.variant
    );
    return {
      kind: 'error',
      message: `${label} stays failed: ${refusal?.reason ?? 'the benchmark cannot run this pair.'}`,
    };
  }
  return {
    kind: 'error',
    message: `${label} was not re-admitted: it is no longer failed or is running`,
  };
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
      const outcome = readmitOutcome(data, entry);
      if (outcome.kind === 'success') toast.success(outcome.message);
      else toast.error(outcome.message);
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
