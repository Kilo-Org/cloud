import React from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { DataExportListRow } from './data-export-types';
import {
  emailStatusBadgeClass,
  formatAge,
  formatBytes,
  formatCount,
  formatTimestamp,
  humanizeToken,
  severityBadgeClass,
  severityLabel,
  statusBadgeClass,
} from './data-export-format';

const COLUMN_COUNT = 10;
const SKELETON_ROW_COUNT = 5;

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function TimestampCell({ value, asOf }: { value: string; asOf: string | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap">
      <span>{formatTimestamp(value)}</span>
      {asOf ? (
        <span className="text-muted-foreground text-xs">{formatAge(value, asOf)}</span>
      ) : null}
    </div>
  );
}

function HealthCell({ health }: { health: DataExportListRow['health'] }) {
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <Badge variant="outline" className={severityBadgeClass(health.severity)}>
        {severityLabel(health.severity)}
      </Badge>
      <span className="text-muted-foreground text-xs">
        {humanizeToken(health.execution)}
        {health.reasons.length > 0
          ? ` · ${health.reasons.length} reason${health.reasons.length === 1 ? '' : 's'}`
          : ''}
      </span>
    </div>
  );
}

function DataExportRow({ row, asOf }: { row: DataExportListRow; asOf: string | undefined }) {
  return (
    <TableRow>
      <TableCell className="text-sm">
        <TimestampCell value={row.requestedAt} asOf={asOf} />
        <span className="text-muted-foreground font-mono text-xs">{shortId(row.id)}</span>
      </TableCell>
      <TableCell>
        <HealthCell health={row.health} />
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={statusBadgeClass(row.status)}>
          {humanizeToken(row.status)}
        </Badge>
      </TableCell>
      <TableCell className="w-56 max-w-56 text-sm">
        <div className="flex flex-col gap-0.5">
          <Link
            className="text-link hover:text-link-hover block max-w-56 truncate rounded-sm underline decoration-current/40 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={`/admin/users/${encodeURIComponent(row.user.id)}`}
            title={row.user.email}
          >
            {row.user.email}
          </Link>
          {row.user.name ? (
            <span
              className="text-muted-foreground block max-w-56 truncate text-xs"
              title={row.user.name}
            >
              {row.user.name}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-sm">
        <div className="flex flex-col gap-0.5">
          <span>{row.currentSource ? 'Legacy generator state' : 'One-shot export'}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            Generation {row.dispatchGeneration}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-sm tabular-nums">{formatCount(row.attemptCount)}</TableCell>
      <TableCell className="text-sm">
        <div className="flex flex-col gap-0.5 tabular-nums">
          <span>{formatCount(row.rowCount)} rows</span>
          <span className="text-muted-foreground text-xs">{formatBytes(row.sizeBytes)}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Badge variant="outline" className={emailStatusBadgeClass(row.emailStatus)}>
            {humanizeToken(row.emailStatus)}
          </Badge>
          {row.emailAttemptCount > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {row.emailAttemptCount} attempt{row.emailAttemptCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-sm">
        <TimestampCell value={row.updatedAt} asOf={asOf} />
      </TableCell>
      <TableCell>
        <Button variant="secondary" size="sm" asChild>
          <Link href={`/admin/data-exports/${encodeURIComponent(row.id)}`}>View</Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, rowIndex) => (
        <TableRow key={rowIndex}>
          {Array.from({ length: COLUMN_COUNT }, (_, cellIndex) => (
            <TableCell key={cellIndex}>
              <Skeleton className="h-4 w-full max-w-24" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export function DataExportsTable({
  rows,
  asOf,
  isLoading,
}: {
  rows: DataExportListRow[];
  asOf: string | undefined;
  isLoading: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Requested</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Execution</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Rows / size</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && rows.length === 0 ? <SkeletonRows /> : null}
          {!isLoading && rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="h-24 text-center">
                <div className="flex flex-col items-center gap-1">
                  <p className="text-sm font-medium">No exports match these filters</p>
                  <p className="text-muted-foreground text-sm">
                    Widen the health filter or clear the search to see more exports.
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map(row => (
            <DataExportRow key={row.id} row={row} asOf={asOf} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
