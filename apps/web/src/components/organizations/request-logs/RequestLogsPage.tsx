'use client';

import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import {
  formatCount,
  formatDurationMs,
  formatMicrodollarsAsUsd,
  formatRequestTime,
} from './format';
import { EnkryptUsageTab } from './EnkryptUsageTab';
import { RequestLogDetailsSheet, userLabel, type RequestLogRow } from './RequestLogDetailsSheet';

const COLUMNS = [
  { label: 'Time' },
  { label: 'User' },
  { label: 'Model' },
  { label: 'Provider' },
  { label: 'Cost', numeric: true },
  { label: 'Input tokens', numeric: true },
  { label: 'Output tokens', numeric: true },
  { label: 'Cache read tokens', numeric: true },
  { label: 'BYOK' },
  { label: 'Error' },
  { label: 'Project' },
  { label: 'Feature' },
  { label: 'Latency', numeric: true },
  { label: 'Generation time', numeric: true },
] as const;

const EMPTY = <span className="text-muted-foreground">—</span>;

function RequestLogTableRow({
  row,
  selected,
  onSelect,
}: {
  row: RequestLogRow;
  selected: boolean;
  onSelect: (row: RequestLogRow) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(row);
    }
  };

  return (
    <TableRow
      tabIndex={0}
      aria-selected={selected}
      data-state={selected ? 'selected' : undefined}
      onClick={() => onSelect(row)}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
    >
      <TableCell className="whitespace-nowrap tabular-nums" title={row.created_at}>
        {formatRequestTime(row.created_at)}
      </TableCell>
      <TableCell className="max-w-48">
        <div className="truncate" title={row.user.email ?? row.user.id}>
          {userLabel(row.user)}
        </div>
      </TableCell>
      <TableCell className="max-w-64">
        <div className="truncate font-mono text-xs" title={row.model ?? undefined}>
          {row.model ?? EMPTY}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{row.provider ?? ''}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMicrodollarsAsUsd(row.cost_microdollars)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.input_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.output_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.cache_hit_tokens)}</TableCell>
      <TableCell>{row.is_user_byok ? <Badge variant="secondary">BYOK</Badge> : EMPTY}</TableCell>
      <TableCell>{row.has_error ? <Badge variant="destructive">Error</Badge> : EMPTY}</TableCell>
      <TableCell className="max-w-40">
        <div className="truncate" title={row.project_id ?? undefined}>
          {row.project_id ?? EMPTY}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{row.feature ?? EMPTY}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatDurationMs(row.latency_ms)}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatDurationMs(row.generation_time_ms)}
      </TableCell>
    </TableRow>
  );
}

function LoadingRows() {
  return Array.from({ length: 8 }, (_, rowIndex) => (
    <TableRow key={rowIndex}>
      {COLUMNS.map(column => (
        <TableCell key={column.label}>
          <Skeleton className="h-4 w-16" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

function RequestsTab({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const [selectedRow, setSelectedRow] = useState<RequestLogRow | null>(null);
  const logsQuery = useQuery(trpc.organizations.requestLogs.list.queryOptions({ organizationId }));
  const rows = logsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          The organization&apos;s latest 100 gateway requests from the past 24 hours. Select a
          request to see how it was routed.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void logsQuery.refetch()}
          disabled={logsQuery.isFetching}
        >
          <RefreshCw className={cn('size-4', logsQuery.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {logsQuery.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not load request logs: {logsQuery.error.message}
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
              {logsQuery.isPending ? (
                <LoadingRows />
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMNS.length}
                    className="text-muted-foreground py-10 text-center"
                  >
                    No requests in the past 24 hours.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(row => (
                  <RequestLogTableRow
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

      <RequestLogDetailsSheet
        organizationId={organizationId}
        row={selectedRow}
        onOpenChange={open => {
          if (!open) setSelectedRow(null);
        }}
      />
    </div>
  );
}

const TABS = ['requests', 'enkrypt'] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string | null): value is Tab {
  return TABS.some(tab => tab === value);
}

export function RequestLogsPage({ organizationId }: { organizationId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isTab(tabParam) ? tabParam : 'requests';

  const onTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'requests') params.delete('tab');
    else params.set('tab', value);
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  };

  return (
    <div className="flex w-full flex-col gap-y-6 p-4 md:p-6">
      <OrganizationPageHeader organizationId={organizationId} title="Request Logs" />
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="enkrypt">Enkrypt</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsTab organizationId={organizationId} />
        </TabsContent>
        <TabsContent value="enkrypt">
          <EnkryptUsageTab organizationId={organizationId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
