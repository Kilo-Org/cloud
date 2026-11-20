'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatMicrodollarsAdaptive } from '@/lib/admin-utils';
import { formatLargeNumber } from '@/lib/utils';
import type { BenchmarkChargesOutput } from './types';

/** One rendered table row: a pool, or one of its concrete models, or its folded remainder. */
export type BenchmarkChargeRow = {
  /** Stable React key; the full project id for pools so pools that share a slug stay distinct. */
  key: string;
  kind: 'pool' | 'model' | 'other';
  label: string;
  costMicrodollars: number;
  requestCount: number;
  poolProjectId: string;
};

/**
 * Flattens the server's pool tree into table rows: each pool, then its listed
 * concrete models, then a folded "other models" row when charges remain.
 *
 * Reading the numbers here (not re-summing models) keeps each pool row equal to
 * the server's pool total, which is what makes the benchmark view reconcile with
 * the same project's usage elsewhere in the dashboard.
 */
export function benchmarkChargeRows(
  output: BenchmarkChargesOutput | undefined
): BenchmarkChargeRow[] {
  if (!output || output.status === 'empty') return [];
  return output.pools.flatMap(pool => {
    const rows: BenchmarkChargeRow[] = [
      {
        key: pool.projectId,
        kind: 'pool',
        label: pool.poolSlug,
        costMicrodollars: pool.costMicrodollars,
        requestCount: pool.requestCount,
        poolProjectId: pool.projectId,
      },
    ];
    for (const model of pool.models) {
      rows.push({
        key: `${pool.projectId}:${model.model}`,
        kind: 'model',
        label: model.model,
        costMicrodollars: model.costMicrodollars,
        requestCount: model.requestCount,
        poolProjectId: pool.projectId,
      });
    }
    if (pool.otherModelsCostMicrodollars !== 0 || pool.otherModelsRequestCount !== 0) {
      rows.push({
        key: `${pool.projectId}:other`,
        kind: 'other',
        label: 'Other models',
        costMicrodollars: pool.otherModelsCostMicrodollars,
        requestCount: pool.otherModelsRequestCount,
        poolProjectId: pool.projectId,
      });
    }
    return rows;
  });
}

type BenchmarkChargesCardProps = {
  data: BenchmarkChargesOutput | undefined;
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
};

/**
 * Auto-routing benchmark charges: each measured pool with its concrete-model
 * split, inside the ordinary usage view so benchmark spend is one billing
 * category with the rest of the caller's usage rather than a parallel ledger.
 */
export function BenchmarkChargesCard({
  data,
  loading,
  isError,
  onRetry,
}: BenchmarkChargesCardProps) {
  const rows = useMemo(() => benchmarkChargeRows(data), [data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Benchmark charges</CardTitle>
        <CardDescription>
          Model requests run by auto-routing benchmark pools, grouped by pool and concrete model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isError ? (
          <div role="alert" className="flex items-center justify-between gap-3">
            <p>Benchmark charges could not load.</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : loading ? (
          <p role="status">Loading benchmark charges…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No benchmark charges in this period. Starting a pool benchmark adds its model requests
            here.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pool and model</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.key}>
                    <TableCell
                      className={
                        row.kind === 'pool'
                          ? 'font-medium'
                          : row.kind === 'model'
                            ? 'text-muted-foreground pl-6'
                            : 'text-muted-foreground pl-6 italic'
                      }
                    >
                      {row.label}
                      {row.kind === 'pool' && (
                        <Badge variant="secondary" className="ml-2 align-middle">
                          Pool
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* Benchmark requests are routinely sub-cent, so plain
                          2-decimal money would show every row as $0.00. */}
                      {formatMicrodollarsAdaptive(row.costMicrodollars)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLargeNumber(row.requestCount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data?.hasMorePools && (
              <p role="status" className="text-muted-foreground text-sm">
                More pools have charges in this period. Choose a shorter date range to see them all.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
