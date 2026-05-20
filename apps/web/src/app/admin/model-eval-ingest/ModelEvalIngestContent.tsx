'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 50;

export function ModelEvalIngestContent() {
  const trpc = useTRPC();
  const [page, setPage] = useState(1);
  const historyQuery = useQuery(
    trpc.admin.modelEvalIngest.list.queryOptions({ page, limit: PAGE_SIZE })
  );
  const syncMutation = useMutation(
    trpc.admin.modelEvalIngest.syncNow.mutationOptions({
      onSuccess: result => {
        toast.success(formatSyncToast(result));
        void historyQuery.refetch();
      },
      onError: error => toast.error(error.message || 'Model eval sync failed'),
    })
  );
  const repullMutation = useMutation(
    trpc.admin.modelEvalIngest.repullPromotion.mutationOptions({
      onSuccess: result => {
        toast.success(
          `Promotion re-pull fetched ${result.fetched} records and refreshed ${result.cacheRecomputes} caches`
        );
        void historyQuery.refetch();
      },
      onError: error => toast.error(error.message || 'Promotion re-pull failed'),
    })
  );

  const rows = historyQuery.data?.rows ?? [];
  const pagination = historyQuery.data?.pagination;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Model Benchmarks</h2>
          <p className="text-muted-foreground max-w-4xl">
            Audit promoted kilo-bench evals that cloud has pulled, then refresh the public Kilo
            Bench cache on demand. Bench remains the aggregate source; this table is the cloud-side
            ingest history.
          </p>
        </div>
        <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          <RefreshCw className={`size-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
          {syncMutation.isPending ? 'Syncing...' : 'Sync now'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Promotion history</CardTitle>
          <CardDescription>
            Rows are append-only and deduplicated by bench eval name. Promoter email and bench links
            stay admin-only here, never in the public model-stats cache.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bench eval</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Trials</TableHead>
                  <TableHead>Promoted</TableHead>
                  <TableHead>Promoter</TableHead>
                  <TableHead>Ingested</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
                      {historyQuery.isLoading
                        ? 'Loading ingest history...'
                        : 'No ingested promotions yet.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map(row => (
                    <TableRow key={row.id}>
                      <TableCell className="min-w-64">
                        <a
                          href={row.benchEvalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-80 items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
                        >
                          <span className="truncate">{row.benchEvalName}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      </TableCell>
                      <TableCell className="min-w-56 font-mono text-xs">
                        <div>{row.model}</div>
                        <div className="text-muted-foreground">
                          {row.provider}
                          {row.variant ? ` / ${row.variant}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>{row.taskSource}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatScore(row.overallScore)}
                        <div className="text-muted-foreground text-xs">
                          total {formatScore(row.totalScore)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {row.nTotalTrials}
                        <div className="text-muted-foreground text-xs">{row.nErrored} errored</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatTimestamp(row.promotedAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {row.promotedByEmail}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatTimestamp(row.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            repullMutation.mutate({ promotionName: row.benchEvalName })
                          }
                          disabled={repullMutation.isPending}
                        >
                          Repull
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground">
              {pagination ? `${pagination.total} ingested promotion rows` : 'Loading row count...'}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage(current => Math.max(1, current - 1))}
                disabled={page <= 1 || historyQuery.isFetching}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage(current => current + 1)}
                disabled={!pagination || page >= pagination.totalPages || historyQuery.isFetching}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

function formatSyncToast(result: {
  inserted: number;
  alreadyHad: number;
  fetched: number;
}): string {
  if (result.inserted > 0) {
    const inserted = `Bench sync inserted ${formatCount(result.inserted, 'new promotion')}.`;
    return result.alreadyHad > 0
      ? `${inserted} ${formatCount(result.alreadyHad, 'existing promotion')} rechecked.`
      : inserted;
  }

  if (result.alreadyHad > 0) {
    return `Bench sync is up to date; ${formatCount(result.alreadyHad, 'existing promotion')} rechecked.`;
  }

  return `Bench sync is up to date; ${formatCount(result.fetched, 'promotion')} returned.`;
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}
