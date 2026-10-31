'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AlertCircle, Info, RefreshCw } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AiRequestKeySource, AiRequestRow } from '@/routers/user-ai-requests-router';
import { KEY_SOURCE_LABELS, formatMicrodollarCount, formatMicrodollarsAsUsd } from './format';

const RANGE_OPTIONS = {
  '24h': { label: 'Last 24 hours', days: 1 },
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
} as const;
type RangeKey = keyof typeof RANGE_OPTIONS;

const KEY_FILTER_OPTIONS = {
  all: 'All keys',
  user_byok: 'Your key (BYOK)',
  kilo: 'Kilo credits',
} as const;
type KeyFilter = keyof typeof KEY_FILTER_OPTIONS;

function isRangeKey(value: string): value is RangeKey {
  return value in RANGE_OPTIONS;
}

function isKeyFilter(value: string): value is KeyFilter {
  return value in KEY_FILTER_OPTIONS;
}

function rangeFor(key: RangeKey, anchorMs: number) {
  return {
    startDate: new Date(anchorMs - RANGE_OPTIONS[key].days * 86_400_000).toISOString(),
    endDate: new Date(anchorMs).toISOString(),
  };
}

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function formatTimestamp(iso: string) {
  return timestampFormat.format(new Date(iso));
}

const numberFormat = new Intl.NumberFormat('en-US');

function KeySourceBadge({ source }: { source: AiRequestKeySource }) {
  const variant = source === 'user_byok' ? 'new' : source === 'kilo' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{KEY_SOURCE_LABELS[source]}</Badge>;
}

function Cost({ microdollars }: { microdollars: string }) {
  return (
    <div className="flex flex-col font-mono tabular-nums">
      <span>{formatMicrodollarsAsUsd(microdollars)}</span>
      <span className="text-muted-foreground text-xs">
        {formatMicrodollarCount(microdollars)} µ$
      </span>
    </div>
  );
}

function Tokens({ request }: { request: AiRequestRow }) {
  const cached = request.cacheHitTokens + request.cacheWriteTokens;
  return (
    <div className="flex flex-col font-mono text-xs tabular-nums">
      <span>
        {numberFormat.format(request.inputTokens)} in · {numberFormat.format(request.outputTokens)}{' '}
        out
      </span>
      {cached > 0 && (
        <span className="text-muted-foreground">
          {numberFormat.format(request.cacheHitTokens)} cache read ·{' '}
          {numberFormat.format(request.cacheWriteTokens)} cache write
        </span>
      )}
    </div>
  );
}

function ModelCell({ request }: { request: AiRequestRow }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-mono text-xs" title={request.model ?? undefined}>
        {request.model ?? '—'}
      </span>
      {request.requestedModel && request.requestedModel !== request.model && (
        <span className="text-muted-foreground truncate text-xs" title={request.requestedModel}>
          requested {request.requestedModel}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ hasError }: { hasError: boolean | null }) {
  if (hasError === true) return <Badge variant="destructive">Error</Badge>;
  if (hasError === false) return <span className="text-muted-foreground text-xs">OK</span>;
  return <span className="text-muted-foreground text-xs">—</span>;
}

function RequestsTable({ requests }: { requests: AiRequestRow[] }) {
  return (
    <div className="hidden md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Key</TableHead>
            <TableHead className="text-right">Charged to credits</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map(request => (
            <TableRow key={request.id}>
              <TableCell className="text-xs whitespace-nowrap">
                <time dateTime={request.createdAt}>{formatTimestamp(request.createdAt)}</time>
              </TableCell>
              <TableCell className="max-w-64">
                <ModelCell request={request} />
              </TableCell>
              <TableCell className="text-xs">{request.provider ?? '—'}</TableCell>
              <TableCell>
                <Tokens request={request} />
              </TableCell>
              <TableCell>
                <KeySourceBadge source={request.keySource} />
              </TableCell>
              <TableCell className="text-right text-xs">
                <Cost microdollars={request.costMicrodollars} />
              </TableCell>
              <TableCell>
                <StatusBadge hasError={request.hasError} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RequestsList({ requests }: { requests: AiRequestRow[] }) {
  return (
    <ul className="divide-border divide-y md:hidden">
      {requests.map(request => (
        <li key={request.id} className="flex flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-3">
            <ModelCell request={request} />
            <KeySourceBadge source={request.keySource} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <time dateTime={request.createdAt}>{formatTimestamp(request.createdAt)}</time>
            {request.provider && <span>{request.provider}</span>}
            <StatusBadge hasError={request.hasError} />
          </div>
          <div className="flex items-end justify-between gap-3 text-xs">
            <Tokens request={request} />
            <div className="text-right">
              <span className="sr-only">Charged to credits: </span>
              <Cost microdollars={request.costMicrodollars} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading requests">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-4/5" />
    </div>
  );
}

export function AiRequestsClient() {
  const trpc = useTRPC();
  const [rangeKey, setRangeKey] = useState<RangeKey>('7d');
  const [keyFilter, setKeyFilter] = useState<KeyFilter>('all');
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const range = useMemo(() => rangeFor(rangeKey, anchorMs), [rangeKey, anchorMs]);

  const query = useInfiniteQuery(
    trpc.userAiRequests.list.infiniteQueryOptions(
      { ...range, keySource: keyFilter },
      { getNextPageParam: page => page.nextCursor ?? undefined, staleTime: 60_000 }
    )
  );

  const requests = query.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={rangeKey}
          onValueChange={value => {
            if (!isRangeKey(value)) return;
            setRangeKey(value);
            setAnchorMs(Date.now());
          }}
        >
          <SelectTrigger className="w-44" aria-label="Date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RANGE_OPTIONS).map(([key, option]) => (
              <SelectItem key={key} value={key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={keyFilter}
          onValueChange={value => {
            if (isKeyFilter(value)) setKeyFilter(value);
          }}
        >
          <SelectTrigger className="w-44" aria-label="API key">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(KEY_FILTER_OPTIONS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnchorMs(Date.now())}
          disabled={query.isFetching}
        >
          <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} aria-hidden />
          Refresh
        </Button>
      </div>

      <div className="text-muted-foreground flex items-start gap-2 text-sm">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          Personal-account requests, newest first. New requests can take a few hours to appear.
          “Charged to credits” is the exact amount deducted from your Kilo balance, in USD and
          microdollars (µ$; 1,000,000 µ$ = $1). “Your key” means the request was recorded as using
          an API key you added under Bring Your Own Key (BYOK), so the provider bills you directly.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isPending ? (
            <LoadingRows />
          ) : !query.data ? (
            <div
              role="alert"
              className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center"
            >
              <AlertCircle className="text-muted-foreground size-5" aria-hidden />
              <div>
                <h2 className="type-heading">Requests are unavailable</h2>
                <p className="type-body text-muted-foreground mt-1 max-w-md">
                  Your request history could not be loaded. This is not an empty period — try again.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : requests.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              No requests in this period. Requests from the last few hours may not have arrived yet.
            </p>
          ) : (
            <>
              <RequestsTable requests={requests} />
              <RequestsList requests={requests} />
            </>
          )}
        </CardContent>
      </Card>

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {query.isError && query.data && !query.isFetchNextPageError && (
        <p role="alert" className="text-muted-foreground text-center text-sm">
          Requests could not be refreshed. Showing the last loaded results.
        </p>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-muted-foreground text-center text-sm">
          More requests could not be loaded. Try again.
        </p>
      )}
    </div>
  );
}
