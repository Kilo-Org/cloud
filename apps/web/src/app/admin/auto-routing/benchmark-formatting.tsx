'use client';

import type {
  BenchmarkRoutingTableResponse,
  RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Formatting and the routing-table view shared by the admin benchmark console and the
 * benchmark-requests section. This module is a leaf on purpose: both of those files render
 * it, so it must not import either of them (that was a dependency cycle).
 */

export function formatAccuracy(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatUsd(n: number | null): string {
  if (n === null) return '—';
  // 6 dp, remove trailing zeros, but keep at least $0.000001 precision
  const fixed = n.toFixed(6);
  // Trim trailing zeros after decimal, but leave at least one digit after dot
  const trimmed = fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return `$${trimmed}`;
}

export function costPerAccuracy(candidate: Pick<RankedCandidate, 'accuracy' | 'avgCostUsd'>) {
  return candidate.accuracy > 0
    ? candidate.avgCostUsd / candidate.accuracy
    : Number.POSITIVE_INFINITY;
}

/**
 * A run or pair total, which is a sum of many small case costs: two decimals
 * would render every real run as $0.00, so a sub-cent total keeps its own
 * precision. A non-zero total below that precision never reads as free.
 */
export function formatTotalUsd(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '$0';
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  // Small totals stay readable to the sixth decimal, without trailing zeros.
  const small = Number(n.toFixed(6));
  return small === 0 ? '<$0.000001' : `$${small}`;
}

export function formatCostPerAccuracy(candidate: Pick<RankedCandidate, 'accuracy' | 'avgCostUsd'>) {
  const value = costPerAccuracy(candidate);
  return Number.isFinite(value) ? formatUsd(value) : '—';
}

// Below this share of the expected cases the completion rate is still noise, so
// no finish time is projected from it.
const ETA_MIN_PERCENT = 5;

export type RunProgressDisplay = {
  /** Null when the run's expected total is unknown; render counts without a bar. */
  percent: number | null;
  counts: string;
  eta: string | null;
};

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Counts, percentage and projected finish for one benchmark run's live progress. */
export function formatRunProgress(
  progress: { completedCases: number; totalCases: number | null; failedCases: number },
  startedAt: string,
  now: number = Date.now()
): RunProgressDisplay {
  const { completedCases, totalCases } = progress;
  const failed = progress.failedCases > 0 ? ` · ${progress.failedCases} failed` : '';
  if (totalCases === null || totalCases <= 0) {
    return { percent: null, counts: `${completedCases} / ? cases${failed}`, eta: null };
  }
  const percent = Math.min(100, (completedCases / totalCases) * 100);
  const startedMs = Date.parse(startedAt);
  const elapsedMs = now - startedMs;
  const remainingCases = totalCases - completedCases;
  const eta =
    completedCases > 0 &&
    remainingCases > 0 &&
    percent >= ETA_MIN_PERCENT &&
    Number.isFinite(startedMs) &&
    elapsedMs > 0
      ? formatDuration((elapsedMs / completedCases) * remainingCases)
      : null;
  return {
    percent,
    counts: `${completedCases} / ${totalCases} cases${failed}`,
    eta,
  };
}

/**
 * One router's ranked pairs per taxonomy route: the first-ranked pair summarized on the
 * row, every candidate in the expansion. The console uses it for the published platform
 * table and the requests section for a pool's routing result.
 */
export function RoutingTableView({ data }: { data: BenchmarkRoutingTableResponse }) {
  if (!data.table) {
    return <p className="text-muted-foreground text-sm">No routing table published yet.</p>;
  }

  const { table } = data;
  const routeEntries = Object.entries(table.routes).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-3">
      {routeEntries.map(([routeKey, candidates]) => {
        const first = candidates[0];
        return (
          <Collapsible key={routeKey} className="rounded-md border">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size={null}
                className="min-h-11 w-full justify-start gap-3 whitespace-normal px-3 py-2 text-left [&[data-state=open]>svg]:rotate-90"
              >
                <ChevronRight className="size-4 shrink-0" />
                <span className="grid flex-1 gap-x-4 gap-y-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto]">
                  <span className="break-all font-mono text-xs">{routeKey}</span>
                  <span className="break-all text-xs">
                    <span className="text-muted-foreground">First-ranked: </span>
                    {first
                      ? `${first.model} · ${first.variant ?? first.reasoningEffort ?? 'default'}`
                      : 'No ranked pairs'}
                  </span>
                  <span className="text-xs tabular-nums">
                    {first ? `Accuracy ${formatAccuracy(first.accuracy)}` : '—'}
                  </span>
                  <span className="text-xs tabular-nums">
                    {first ? `Avg cost ${formatUsd(first.avgCostUsd)}` : '—'}
                  </span>
                  <span className="text-xs">
                    {first ? (first.meetsThreshold ? 'Meets threshold' : 'Below threshold') : '—'}
                  </span>
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="overflow-x-auto border-t">
                <Table className="min-w-max">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="w-36">Effort</TableHead>
                      <TableHead className="text-right">Accuracy</TableHead>
                      <TableHead className="text-right">Avg cost</TableHead>
                      <TableHead className="text-right">Cost / accuracy</TableHead>
                      <TableHead>Threshold</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map((c, i) => (
                      <TableRow key={`${routeKey}-${c.model}-${i}`}>
                        <TableCell className="text-xs tabular-nums">{i + 1}</TableCell>
                        <TableCell className="max-w-56 break-all font-mono text-xs">
                          {c.model}
                        </TableCell>
                        <TableCell className="capitalize text-xs">
                          {c.variant ?? c.reasoningEffort ?? 'default'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatAccuracy(c.accuracy)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatUsd(c.avgCostUsd)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatCostPerAccuracy(c)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={c.meetsThreshold ? 'default' : 'secondary'}>
                            {c.meetsThreshold ? 'meets' : 'below'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
