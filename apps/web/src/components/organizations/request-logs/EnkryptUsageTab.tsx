'use client';

import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  ENKRYPT_USAGE_OUTCOMES,
  ENKRYPT_USAGE_WINDOW_HOURS,
  REQUEST_LOGS_LIMIT,
  REQUEST_LOGS_START_TIME_MAX_AGE_DAYS,
  isRequestLogStartTimeInBounds,
  type EnkryptUsageOutcome,
} from '@/lib/request-logs/filters';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { ABSENT_CELL, ToneBadge } from './detail-primitives';
import {
  GUARDRAIL_LABELS,
  OUTCOMES,
  firedDetectorsLabel,
  type EnkryptGuardrail,
  type EnkryptUsageRow,
} from './enkrypt-usage-labels';
import { EnkryptRequestSheet } from './EnkryptRequestSheet';
import { formatDurationMs, formatMicrodollarsAsUsd, formatRequestTime } from './format';
import { userLabel } from './RequestLogDetailsSheet';
import { OptionFilter, StartTimeFilter, UserFilter, parseStartParam } from './RequestLogFilters';

type EnkryptFilters = {
  startTime: string | null;
  userId: string | null;
  outcome: EnkryptUsageOutcome | null;
  guardrail: EnkryptGuardrail | null;
};

type EnkryptFilterParamUpdate = Partial<
  Record<'start' | 'user' | 'outcome' | 'guardrail', string | null>
>;

const OUTCOME_OPTIONS = ENKRYPT_USAGE_OUTCOMES.map(outcome => ({
  value: outcome,
  label: OUTCOMES[outcome].label,
}));

const GUARDRAIL_OPTIONS = (['input', 'output'] as const).map(guardrail => ({
  value: guardrail,
  label: GUARDRAIL_LABELS[guardrail],
}));

const COLUMNS = [
  { label: 'Time' },
  { label: 'User' },
  { label: 'Model' },
  { label: 'Guardrail' },
  { label: 'Decision' },
  { label: 'Detectors fired' },
  { label: 'Charged', numeric: true },
  { label: 'Added latency', numeric: true },
  { label: 'Session' },
] as const;

export function parseEnkryptFilters(params: {
  get: (name: string) => string | null;
}): EnkryptFilters {
  const outcome = params.get('outcome');
  const guardrail = params.get('guardrail');
  return {
    startTime: parseStartParam(params.get('start')),
    userId: params.get('user') || null,
    outcome: ENKRYPT_USAGE_OUTCOMES.find(value => value === outcome) ?? null,
    guardrail: guardrail === 'input' || guardrail === 'output' ? guardrail : null,
  };
}

function EnkryptUsageTableRow({
  row,
  selected,
  onSelect,
}: {
  row: EnkryptUsageRow;
  selected: boolean;
  onSelect: (row: EnkryptUsageRow) => void;
}) {
  const outcome = OUTCOMES[row.outcome];
  const detectors = firedDetectorsLabel(row);
  const selectable = row.request_id !== null;
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(row);
    }
  };

  return (
    <TableRow
      {...(selectable && {
        tabIndex: 0,
        'aria-selected': selected,
        onClick: () => onSelect(row),
        onKeyDown: handleKeyDown,
        className:
          'focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
      })}
      data-state={selected ? 'selected' : undefined}
    >
      <TableCell className="whitespace-nowrap tabular-nums" title={row.created_at}>
        {formatRequestTime(row.created_at)}
      </TableCell>
      <TableCell className="max-w-48">
        <div className="truncate" title={row.user.email ?? row.user.id}>
          {userLabel(row.user)}
        </div>
      </TableCell>
      <TableCell className="max-w-56">
        <div className="truncate font-mono text-xs" title={row.model ?? undefined}>
          {row.model ?? ABSENT_CELL}
        </div>
      </TableCell>
      <TableCell>{GUARDRAIL_LABELS[row.guardrail]}</TableCell>
      <TableCell>
        <ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>
      </TableCell>
      <TableCell className="max-w-56">
        <div className="truncate" title={detectors ?? undefined}>
          {detectors ?? ABSENT_CELL}
        </div>
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMicrodollarsAsUsd(row.charged_microdollars)}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatDurationMs(row.added_latency_ms)}
      </TableCell>
      <TableCell className="max-w-56">
        <div className="truncate font-mono text-xs" title={row.session_id ?? undefined}>
          {row.session_id ?? ABSENT_CELL}
        </div>
      </TableCell>
    </TableRow>
  );
}

function MessageRow({ children }: { children: string }) {
  return (
    <TableRow>
      <TableCell colSpan={COLUMNS.length} className="text-muted-foreground py-10 text-center">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function EnkryptUsageTab({
  organizationId,
  filters,
  onFiltersChange,
}: {
  organizationId: string;
  filters: EnkryptFilters;
  onFiltersChange: (update: EnkryptFilterParamUpdate) => void;
}) {
  const trpc = useTRPC();
  const [selectedRow, setSelectedRow] = useState<EnkryptUsageRow | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const startTimeError =
    filters.startTime && !isRequestLogStartTimeInBounds(Date.parse(filters.startTime), mountedAt)
      ? `Choose a start time within the past ${REQUEST_LOGS_START_TIME_MAX_AGE_DAYS} days.`
      : null;
  const usageQuery = useQuery({
    ...trpc.organizations.requestLogs.listEnkryptUsage.queryOptions({
      organizationId,
      startTime: filters.startTime ?? undefined,
      userId: filters.userId ?? undefined,
      outcome: filters.outcome ?? undefined,
      guardrail: filters.guardrail ?? undefined,
    }),
    enabled: startTimeError === null,
  });
  const rows = usageQuery.data ?? [];
  const isFiltered =
    filters.userId !== null || filters.outcome !== null || filters.guardrail !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <StartTimeFilter
            id="enkrypt-usage-start"
            startTime={filters.startTime}
            rollingTime={usageQuery.dataUpdatedAt || mountedAt}
            error={startTimeError}
            onChange={startTime => onFiltersChange({ start: startTime })}
          />
          <UserFilter
            id="enkrypt-usage-user"
            organizationId={organizationId}
            userId={filters.userId}
            onChange={userId => onFiltersChange({ user: userId })}
          />
          <OptionFilter
            id="enkrypt-usage-outcome"
            label="Decision"
            allLabel="All decisions"
            className="w-40"
            value={filters.outcome}
            options={OUTCOME_OPTIONS}
            onChange={outcome => onFiltersChange({ outcome })}
          />
          <OptionFilter
            id="enkrypt-usage-guardrail"
            label="Guardrail"
            allLabel="All guardrails"
            className="w-40"
            value={filters.guardrail}
            options={GUARDRAIL_OPTIONS}
            onChange={guardrail => onFiltersChange({ guardrail })}
          />
          <Button
            variant="outline"
            size="sm"
            className="mt-6 ml-auto"
            onClick={() => void usageQuery.refetch()}
            disabled={usageQuery.isFetching || startTimeError !== null}
          >
            <RefreshCw className={cn('size-4', usageQuery.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Up to {REQUEST_LOGS_LIMIT} of the organization&apos;s Enkrypt guardrail calls from the{' '}
          {ENKRYPT_USAGE_WINDOW_HOURS} hours before the start time, newest first. Select a call to
          see the request it scanned.
        </p>
      </div>

      {usageQuery.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not load Enkrypt usage: {usageQuery.error.message}
          </AlertDescription>
        </Alert>
      ) : (
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
              {startTimeError ? (
                <MessageRow>Choose a valid start time to see Enkrypt calls.</MessageRow>
              ) : usageQuery.isPending ? (
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
                <MessageRow>
                  {isFiltered
                    ? `No Enkrypt calls match these filters in the ${ENKRYPT_USAGE_WINDOW_HOURS} hours before the start time.`
                    : `No Enkrypt calls in the ${ENKRYPT_USAGE_WINDOW_HOURS} hours before the start time.`}
                </MessageRow>
              ) : (
                rows.map(row => (
                  <EnkryptUsageTableRow
                    key={row.id}
                    row={row}
                    selected={selectedRow?.id === row.id}
                    onSelect={setSelectedRow}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <EnkryptRequestSheet
        organizationId={organizationId}
        call={selectedRow}
        onOpenChange={open => {
          if (!open) setSelectedRow(null);
        }}
      />
    </div>
  );
}
