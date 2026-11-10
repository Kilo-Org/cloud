'use client';

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useDebouncedValue } from '@/components/organizations/guardrails/mcp-and-skills/use-debounced-value';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  REQUEST_LOGS_LIMIT,
  REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH,
  REQUEST_LOGS_START_TIME_MAX_AGE_DAYS,
  isRequestLogStartTimeInBounds,
} from '@/lib/request-logs/filters';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { ABSENT_CELL } from './detail-primitives';
import { formatCount, formatMicrodollarsAsUsd, formatRequestTime } from './format';
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
  { label: 'BYOK' },
] as const;

const ALL_USERS = '__all__';
const MODEL_PREFIX_DEBOUNCE_MS = 300;

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
          {row.model ?? ABSENT_CELL}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{row.provider ?? ABSENT_CELL}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMicrodollarsAsUsd(row.cost_microdollars)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.input_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.output_tokens)}</TableCell>
      <TableCell>
        {row.is_user_byok ? <Badge variant="secondary">BYOK</Badge> : ABSENT_CELL}
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

type RequestFilters = {
  startTime: string | null;
  userId: string | null;
  modelPrefix: string;
};

type FilterParamUpdate = Partial<Record<'start' | 'user' | 'model', string | null>>;

function parseStartParam(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function toDateTimeLocalValue(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function StartTimeFilter({
  startTime,
  rollingTime,
  error,
  onChange,
}: {
  startTime: string | null;
  rollingTime: number;
  error: string | null;
  onChange: (startTime: string | null) => void;
}) {
  const handleChange = (value: string) => {
    const time = value ? new Date(value).getTime() : Number.NaN;
    onChange(Number.isNaN(time) || time >= Date.now() ? null : new Date(time).toISOString());
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="request-logs-start">Start time</Label>
      <div className="flex items-center gap-2">
        <Input
          id="request-logs-start"
          type="datetime-local"
          value={toDateTimeLocalValue(startTime ? Date.parse(startTime) : rollingTime)}
          aria-invalid={error !== null}
          aria-describedby={error ? 'request-logs-start-error' : undefined}
          className="w-56 cursor-pointer tabular-nums [&::-webkit-calendar-picker-indicator]:cursor-pointer"
          onClick={event => event.currentTarget.showPicker?.()}
          onChange={event => handleChange(event.target.value)}
        />
        {startTime && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Now
          </Button>
        )}
      </div>
      {error && (
        <p id="request-logs-start-error" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function UserFilter({
  organizationId,
  userId,
  onChange,
}: {
  organizationId: string;
  userId: string | null;
  onChange: (userId: string | null) => void;
}) {
  const membersQuery = useOrganizationWithMembers(organizationId);
  const users = (membersQuery.data?.members ?? [])
    .flatMap(member =>
      member.status === 'active' ? [{ id: member.id, label: member.name || member.email }] : []
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  if (userId && !users.some(user => user.id === userId)) {
    users.push({ id: userId, label: userId });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="request-logs-user">User</Label>
      <Select
        value={userId ?? ALL_USERS}
        onValueChange={value => onChange(value === ALL_USERS ? null : value)}
      >
        <SelectTrigger id="request-logs-user" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_USERS}>All users</SelectItem>
          {users.map(user => (
            <SelectItem key={user.id} value={user.id}>
              {user.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ModelPrefixFilter({
  modelPrefix,
  onChange,
}: {
  modelPrefix: string;
  onChange: (modelPrefix: string) => void;
}) {
  const [value, setValue] = useState(modelPrefix);
  const debouncedValue = useDebouncedValue(value.trim(), MODEL_PREFIX_DEBOUNCE_MS);

  useEffect(() => {
    if (debouncedValue !== modelPrefix) onChange(debouncedValue);
  }, [debouncedValue, modelPrefix, onChange]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="request-logs-model">Model prefix</Label>
      <Input
        id="request-logs-model"
        value={value}
        maxLength={REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH}
        placeholder="e.g. anthropic/"
        autoComplete="off"
        spellCheck={false}
        className="w-56 font-mono text-xs"
        onChange={event => setValue(event.target.value)}
      />
    </div>
  );
}

function RequestsTab({
  organizationId,
  filters,
  onFiltersChange,
}: {
  organizationId: string;
  filters: RequestFilters;
  onFiltersChange: (update: FilterParamUpdate) => void;
}) {
  const trpc = useTRPC();
  const [selectedRow, setSelectedRow] = useState<RequestLogRow | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const startTimeError =
    filters.startTime && !isRequestLogStartTimeInBounds(Date.parse(filters.startTime), mountedAt)
      ? `Choose a start time within the past ${REQUEST_LOGS_START_TIME_MAX_AGE_DAYS} days.`
      : null;
  const logsQuery = useQuery({
    ...trpc.organizations.requestLogs.list.queryOptions({
      organizationId,
      startTime: filters.startTime ?? undefined,
      userId: filters.userId ?? undefined,
      modelPrefix: filters.modelPrefix || undefined,
    }),
    enabled: startTimeError === null,
  });
  const rows = logsQuery.data ?? [];
  const isFiltered = filters.userId !== null || filters.modelPrefix !== '';
  const onModelPrefixChange = useCallback(
    (modelPrefix: string) => onFiltersChange({ model: modelPrefix || null }),
    [onFiltersChange]
  );

  return (
    <div className="flex flex-col gap-y-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <StartTimeFilter
            startTime={filters.startTime}
            rollingTime={logsQuery.dataUpdatedAt || mountedAt}
            error={startTimeError}
            onChange={startTime => onFiltersChange({ start: startTime })}
          />
          <UserFilter
            organizationId={organizationId}
            userId={filters.userId}
            onChange={userId => onFiltersChange({ user: userId })}
          />
          <ModelPrefixFilter modelPrefix={filters.modelPrefix} onChange={onModelPrefixChange} />
          <Button
            variant="outline"
            size="sm"
            className="mt-6 ml-auto"
            onClick={() => void logsQuery.refetch()}
            disabled={logsQuery.isFetching || startTimeError !== null}
          >
            <RefreshCw className={cn('size-4', logsQuery.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Up to {REQUEST_LOGS_LIMIT} of the organization&apos;s gateway requests from the hour
          before the start time, newest first. Select a request to see how it was routed.
        </p>
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
              {startTimeError ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMNS.length}
                    className="text-muted-foreground py-10 text-center"
                  >
                    Choose a valid start time to see requests.
                  </TableCell>
                </TableRow>
              ) : logsQuery.isPending ? (
                <LoadingRows />
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMNS.length}
                    className="text-muted-foreground py-10 text-center"
                  >
                    {isFiltered
                      ? 'No requests match these filters in the hour before the start time.'
                      : 'No requests in the hour before the start time.'}
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
  const filters: RequestFilters = {
    startTime: parseStartParam(searchParams.get('start')),
    userId: searchParams.get('user') || null,
    modelPrefix: searchParams.get('model')?.trim() ?? '',
  };

  const replaceParams = useCallback(
    (update: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [name, value] of Object.entries(update)) {
        if (value === null) params.delete(name);
        else params.set(name, value);
      }
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return (
    <div className="flex w-full flex-col gap-y-6 p-4 md:p-6">
      <OrganizationPageHeader organizationId={organizationId} title="Request Logs" />
      <Tabs
        value={activeTab}
        onValueChange={value => replaceParams({ tab: value === 'requests' ? null : value })}
        className="flex flex-col gap-4"
      >
        <TabsList className="self-start">
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="enkrypt">Enkrypt</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsTab
            organizationId={organizationId}
            filters={filters}
            onFiltersChange={replaceParams}
          />
        </TabsContent>
        <TabsContent value="enkrypt">
          <EnkryptUsageTab organizationId={organizationId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
