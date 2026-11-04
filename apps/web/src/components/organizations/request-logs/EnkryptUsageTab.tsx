'use client';

import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import type { RootRouter } from '@/routers/root-router';
import { ToneBadge } from './detail-primitives';
import {
  formatCount,
  formatDurationMs,
  formatMicrodollarsAsUsd,
  formatRequestTime,
} from './format';
import type { StepTone } from './routing-labels';

type EnkryptUsage =
  inferRouterOutputs<RootRouter>['organizations']['requestLogs']['listEnkryptUsage'];
type EnkryptUsageRow = EnkryptUsage['rows'][number];

const DECISIONS: Record<string, { label: string; tone: StepTone }> = {
  allowed: { label: 'Allowed', tone: 'selected' },
  blocked: { label: 'Blocked', tone: 'rejected' },
  error: { label: 'Error', tone: 'deferred' },
};

const COLUMNS = [
  { label: 'Time' },
  { label: 'User' },
  { label: 'API' },
  { label: 'Guardrail' },
  { label: 'Decision' },
  { label: 'Charged', numeric: true },
  { label: 'Added latency', numeric: true },
  { label: 'Session' },
] as const;

const EMPTY = <span className="text-muted-foreground">—</span>;

function decisionOf(decision: string) {
  return Object.hasOwn(DECISIONS, decision)
    ? DECISIONS[decision]
    : { label: decision, tone: 'info' as const };
}

function userLabel(user: EnkryptUsageRow['user']): string {
  return user.name || user.email || user.id;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function Summary({ summary }: { summary: EnkryptUsage['summary'] | undefined }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Stat label="Scans" value={summary ? formatCount(summary.total_calls) : '—'} />
      <Stat
        label="Allowed / blocked / error"
        value={summary ? `${summary.allowed} / ${summary.blocked} / ${summary.errors}` : '—'}
      />
      <Stat
        label="Charged"
        value={summary ? formatMicrodollarsAsUsd(summary.total_charged_microdollars) : '—'}
      />
      <Stat
        label="Avg added latency (input)"
        value={
          summary?.avg_input_added_latency_ms != null
            ? formatDurationMs(summary.avg_input_added_latency_ms)
            : '—'
        }
      />
      <Stat
        label="Avg added latency (output)"
        value={
          summary?.avg_output_added_latency_ms != null
            ? formatDurationMs(summary.avg_output_added_latency_ms)
            : '—'
        }
      />
    </div>
  );
}

function EnkryptUsageTableRow({ row }: { row: EnkryptUsageRow }) {
  const decision = decisionOf(row.decision);
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap tabular-nums" title={row.created_at}>
        {formatRequestTime(row.created_at)}
      </TableCell>
      <TableCell className="max-w-48">
        <div className="truncate" title={row.user.email ?? row.user.id}>
          {userLabel(row.user)}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.api_kind}</TableCell>
      <TableCell>{row.guardrail === 'output' ? 'Output' : 'Input'}</TableCell>
      <TableCell>
        <ToneBadge tone={decision.tone}>{decision.label}</ToneBadge>
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMicrodollarsAsUsd(row.charged_microdollars)}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatDurationMs(row.added_latency_ms)}
      </TableCell>
      <TableCell className="max-w-56">
        <div className="truncate font-mono text-xs" title={row.session_id ?? undefined}>
          {row.session_id ?? EMPTY}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function EnkryptUsageTab({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const usageQuery = useQuery(
    trpc.organizations.requestLogs.listEnkryptUsage.queryOptions({ organizationId })
  );
  const rows = usageQuery.data?.rows ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          The organization&apos;s latest 100 Enkrypt guardrail scans from the past 24 hours. The
          totals cover every scan in that window.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void usageQuery.refetch()}
          disabled={usageQuery.isFetching}
        >
          <RefreshCw className={cn('size-4', usageQuery.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {usageQuery.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not load Enkrypt usage: {usageQuery.error.message}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Summary summary={usageQuery.data?.summary} />
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map(column => (
                    <TableHead
                      key={column.label}
                      className={cn('whitespace-nowrap', 'numeric' in column && 'text-right')}
                    >
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {usageQuery.isPending ? (
                  Array.from({ length: 5 }, (_, rowIndex) => (
                    <TableRow key={rowIndex}>
                      {COLUMNS.map(column => (
                        <TableCell key={column.label}>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COLUMNS.length}
                      className="text-muted-foreground py-10 text-center"
                    >
                      No Enkrypt scans in the past 24 hours.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map(row => <EnkryptUsageTableRow key={row.id} row={row} />)
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
