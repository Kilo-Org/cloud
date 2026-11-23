'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React from 'react';
import {
  TAXONOMY_ROUTE_KEYS,
  type AutoRoutingMode,
  type CustomRoutingTable,
} from '@kilocode/auto-routing-contracts';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatPercent,
  formatUsd,
  routeLabel,
  routeTaskLabel,
  routingRows,
} from './benchmark-display';
import { MODE_OPTIONS } from './custom-router-display';

type Props = {
  table: CustomRoutingTable | null;
  mode: AutoRoutingMode;
  defaultEntryLabel: string;
  servingPins?: Record<string, string>;
};

export function BenchmarkRoutingTable({ table, mode, defaultEntryLabel, servingPins = {} }: Props) {
  const modeLabel = MODE_OPTIONS.find(option => option.value === mode)?.label ?? mode;
  const pinnedEntries = Object.entries(servingPins);

  if (table === null) {
    return (
      <div className="bg-muted/30 space-y-2 rounded-md border border-dashed p-4" role="status">
        <p className="text-sm font-medium">No routing table yet</p>
        <p className="text-muted-foreground text-sm">
          Benchmark this pool to measure its models. Until then every route falls back to the
          default model ({defaultEntryLabel}).
        </p>
      </div>
    );
  }

  const rows = routingRows(table, TAXONOMY_ROUTE_KEYS, mode, defaultEntryLabel);

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>
          Mode: <span className="text-foreground">{modeLabel}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          Accuracy floor:{' '}
          <span className="text-foreground">{formatPercent(table.minAccuracy)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>Built {table.generatedAt}</span>
      </div>
      {pinnedEntries.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">Pinned aliases</p>
          <ul className="space-y-0.5">
            {pinnedEntries.map(([entryKey, target]) => (
              <li key={entryKey} className="text-muted-foreground font-mono text-xs break-all">
                {entryKey} → {target}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            These entries keep dispatching the benchmarked model even if the alias moves.
          </p>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route</TableHead>
              <TableHead>Served by</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Accuracy</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => {
              const served = row.candidates?.[0];
              const alternates = row.candidates?.slice(1) ?? [];
              return (
                <TableRow key={row.routeKey}>
                  <TableCell className="align-top">
                    <span className="block">{routeLabel(row.routeKey)}</span>
                    <span className="text-muted-foreground block text-xs">
                      {routeTaskLabel(row.routeKey)}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    {served === undefined ? (
                      <span className="text-muted-foreground">Default model</span>
                    ) : (
                      <div className="space-y-1">
                        <span className="block font-mono break-all">{served.model}</span>
                        <span className="flex flex-wrap gap-1">
                          {served.variant !== undefined && served.variant !== null ? (
                            <Badge variant="secondary">{served.variant}</Badge>
                          ) : null}
                          {served.stale === true ? <Badge variant="warning">Stale</Badge> : null}
                          {!served.meetsThreshold ? (
                            <Badge variant="outline">Below floor</Badge>
                          ) : null}
                        </span>
                        {alternates.length > 0 ? (
                          <span className="text-muted-foreground block text-xs">
                            Alternates:{' '}
                            {alternates
                              .map(
                                candidate =>
                                  `${candidate.model} (${formatPercent(candidate.accuracy)})`
                              )
                              .join(', ')}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-80 align-top text-xs">
                    {row.reason}
                  </TableCell>
                  <TableCell className="align-top text-right tabular-nums">
                    {served === undefined ? '—' : formatPercent(served.accuracy)}
                  </TableCell>
                  <TableCell className="align-top text-right tabular-nums">
                    {served === undefined ? '—' : formatUsd(served.avgCostUsd)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
