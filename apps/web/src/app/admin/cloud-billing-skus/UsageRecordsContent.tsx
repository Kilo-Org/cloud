'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Cloud, Copy, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { useTRPC } from '@/lib/trpc/utils';
import type { ReconciliationStatus } from '@/routers/admin/cloud-billing-skus-router';

type SearchKind = 'interval' | 'user' | 'org';
type CloseReason =
  | 'exit'
  | 'runtime_signal'
  | 'activity_expired'
  | 'reconciled'
  | 'unconfirmed'
  | 'superseded';
type SearchRequest =
  | {
      kind: 'recent';
      status?: 'open' | 'closed';
      closeReason?: CloseReason;
      skuId?: string;
    }
  | {
      kind: 'interval';
      value: string;
      status?: 'open' | 'closed';
      closeReason?: CloseReason;
      skuId?: string;
    }
  | {
      kind: 'user' | 'org';
      value: string;
      status?: 'open' | 'closed';
      closeReason?: CloseReason;
      skuId?: string;
      summaryStart?: string;
      summaryEnd?: string;
    };
type Cursor = { startedAt: string; id: string };
type UsageSummaryRequest = {
  subjectType: 'user' | 'org';
  subjectId: string;
  start: string;
  end: string;
};

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatProviderNumber(value: number | null): string {
  return value === null
    ? 'Unavailable'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected reconciliation status: ${value}`);
}

function reconciliationStatusLabel(status: ReconciliationStatus): string {
  switch (status) {
    case 'missing_from_cloudflare':
      return 'Missing from Cloudflare';
    case 'ambiguous_application':
      return 'Ambiguous application';
    case 'provider_partial':
      return 'Provider partial';
    case 'comparison_unavailable':
      return 'Comparison unavailable';
  }
  return assertNever(status);
}

function reconciliationStatusVariant(status: ReconciliationStatus) {
  switch (status) {
    case 'missing_from_cloudflare':
      return 'destructive' as const;
    case 'ambiguous_application':
      return 'beta' as const;
    case 'provider_partial':
      return 'secondary-outline' as const;
    case 'comparison_unavailable':
      return 'secondary' as const;
  }
  return assertNever(status);
}

function sameSummaryRequest(
  first: UsageSummaryRequest | null | undefined,
  second: UsageSummaryRequest | null | undefined
): boolean {
  return (
    first !== null &&
    first !== undefined &&
    second !== null &&
    second !== undefined &&
    first.subjectType === second.subjectType &&
    first.subjectId === second.subjectId &&
    first.start === second.start &&
    first.end === second.end
  );
}

function formatDifference(seconds: number | null, percent: number | null): string {
  if (seconds === null) return 'Unavailable';
  const secondsPrefix = seconds > 0 ? '+' : '';
  if (percent === null) return `${secondsPrefix}${formatProviderNumber(seconds)}s`;
  const percentPrefix = percent > 0 ? '+' : '';
  return `${secondsPrefix}${formatProviderNumber(seconds)}s (${percentPrefix}${formatProviderNumber(percent)}%)`;
}

function formatProvisionedCapacity(memoryBytes: number | null, diskBytes: number | null) {
  if (memoryBytes === null || diskBytes === null) return null;
  return `${formatProviderNumber(memoryBytes / 1024 ** 3)} GiB memory · ${formatProviderNumber(diskBytes / 1_000_000_000)} GB disk`;
}

function toDateTimeLocalValue(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function adminSubjectHref(type: 'user' | 'org', id: string): string {
  return type === 'user'
    ? `/admin/users/${encodeURIComponent(id)}`
    : `/admin/organizations/${encodeURIComponent(id)}`;
}

function parseCloseReason(value: string | null): CloseReason | undefined {
  return value === 'exit' ||
    value === 'runtime_signal' ||
    value === 'activity_expired' ||
    value === 'reconciled' ||
    value === 'unconfirmed' ||
    value === 'superseded'
    ? value
    : undefined;
}

function SegmentDetails({ intervalId }: { intervalId: string }) {
  const trpc = useTRPC();
  const [afterSeq, setAfterSeq] = useState<number | undefined>();
  const [previousCursors, setPreviousCursors] = useState<Array<number | undefined>>([]);
  const query = useQuery(
    trpc.admin.cloudBillingSkus.listUsageSegments.queryOptions({ intervalId, afterSeq, limit: 100 })
  );
  if (query.isLoading)
    return <p className="text-muted-foreground type-label">Loading segments...</p>;
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Segments could not be loaded</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{query.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const segments = query.data?.items ?? [];
  const metadata = Object.entries(query.data?.metadata ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 font-medium type-body">Metadata</h3>
        {metadata.length === 0 ? (
          <p className="text-muted-foreground type-label">No metadata recorded.</p>
        ) : (
          <dl className="grid gap-x-4 gap-y-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
            {metadata.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground break-all type-code">{key}</dt>
                <dd className="break-all type-code">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div>
        <h3 className="mb-2 font-medium type-body">Segments</h3>
        {segments.length === 0 ? (
          <p className="text-muted-foreground type-label">No segments recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sequence</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Accepted</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map(segment => (
                  <TableRow key={segment.seq}>
                    <TableCell className="tabular-nums type-code">{segment.seq}</TableCell>
                    <TableCell className="tabular-nums type-code">
                      {segment.reported_seconds}s
                    </TableCell>
                    <TableCell className="tabular-nums type-code">
                      {segment.usage_seconds}s
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums type-label">
                      {formatTimestamp(segment.received_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={previousCursors.length === 0 || query.isFetching}
          onClick={() => {
            const previous = [...previousCursors];
            setAfterSeq(previous.pop());
            setPreviousCursors(previous);
          }}
        >
          Previous segments
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => {
            if (!query.data?.nextCursor) return;
            setPreviousCursors(current => [...current, afterSeq]);
            setAfterSeq(query.data.nextCursor ?? undefined);
          }}
        >
          Next segments
        </Button>
      </div>
    </div>
  );
}

export default function UsageRecordsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const trpc = useTRPC();
  const catalog = useQuery(trpc.admin.cloudBillingSkus.list.queryOptions());
  const [kind, setKind] = useState<SearchKind>('user');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'all' | 'open' | 'closed'>('all');
  const urlCloseReason = parseCloseReason(searchParams.get('closeReason'));
  const [closeReason, setCloseReason] = useState<'all' | CloseReason>(urlCloseReason ?? 'all');
  const [skuId, setSkuId] = useState('all');
  const [submitted, setSubmitted] = useState<SearchRequest>({
    kind: 'recent',
    closeReason: closeReason === 'all' ? undefined : closeReason,
  });
  const [cursor, setCursor] = useState<Cursor | undefined>();
  const [previousCursors, setPreviousCursors] = useState<Array<Cursor | undefined>>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [summaryStart, setSummaryStart] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() - 24 * 60 * 60 * 1_000))
  );
  const [summaryEnd, setSummaryEnd] = useState(() => toDateTimeLocalValue(new Date()));
  const [summaryRequest, setSummaryRequest] = useState<UsageSummaryRequest | null>(null);
  const [summaryInputError, setSummaryInputError] = useState<string | null>(null);
  const [rawResponseOpen, setRawResponseOpen] = useState(false);
  const [rawCopyStatus, setRawCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const input = {
    search:
      submitted.kind === 'recent'
        ? ({ kind: 'recent' } as const)
        : submitted.kind === 'interval'
          ? ({ kind: 'interval', id: submitted.value } as const)
          : ({
              kind: 'subject',
              subjectType: submitted.kind,
              subjectId: submitted.value,
              start: submitted.summaryStart ?? '',
              end: submitted.summaryEnd ?? '',
            } as const),
    status: submitted.status,
    closeReason: submitted.closeReason,
    skuId: submitted.skuId,
    cursor,
    limit: submitted.kind === 'recent' ? 10 : 25,
  };
  const results = useQuery(trpc.admin.cloudBillingSkus.searchUsageIntervals.queryOptions(input));
  const summary = useQuery({
    ...trpc.admin.cloudBillingSkus.getUsageSummary.queryOptions(
      summaryRequest ?? {
        subjectType: 'user',
        subjectId: 'not-submitted',
        start: new Date(0).toISOString(),
        end: new Date(1).toISOString(),
      }
    ),
    enabled: summaryRequest !== null,
  });
  // This read is intentionally imperative: Cloudflare must only be queried after an admin click.
  const reconciliation = useMutation(
    trpc.admin.cloudBillingSkus.reconcileUsageWithCloudflare.mutationOptions()
  );
  const resetReconciliation = reconciliation.reset;
  const reconciliationMatchesSummary = sameSummaryRequest(reconciliation.variables, summaryRequest);
  const reconciliationErrorCode = reconciliation.error?.data?.code;
  const reconciliationCanRetry =
    reconciliationErrorCode !== 'BAD_REQUEST' && reconciliationErrorCode !== 'PRECONDITION_FAILED';
  const rows = results.data?.items ?? [];

  const resetResultNavigation = () => {
    setCursor(undefined);
    setPreviousCursors([]);
    setExpandedId(null);
  };

  const replaceCloseReasonParam = (reason: CloseReason | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (reason) params.set('closeReason', reason);
    else params.delete('closeReason');
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  };

  useEffect(() => {
    const next = urlCloseReason ?? 'all';
    setCloseReason(next);
    if (urlCloseReason) setStatus('closed');
    setSubmitted(current => {
      const nextStatus = urlCloseReason && current.status === 'open' ? 'closed' : current.status;
      if (current.closeReason === urlCloseReason && current.status === nextStatus) return current;
      return { ...current, status: nextStatus, closeReason: urlCloseReason };
    });
    resetResultNavigation();
  }, [urlCloseReason]);

  useEffect(() => {
    resetReconciliation();
    setRawResponseOpen(false);
    setRawCopyStatus('idle');
  }, [summaryRequest, resetReconciliation]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Search usage records</CardTitle>
          <CardDescription>
            Search an exact interval ID or the usage history for an exact user or organization ID.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault();
              const trimmed = value.trim();
              if (!trimmed) return;
              let summaryWindow: { summaryStart?: string; summaryEnd?: string } = {};
              if (kind === 'user' || kind === 'org') {
                const start = new Date(summaryStart);
                const end = new Date(summaryEnd);
                const windowMs = end.getTime() - start.getTime();
                if (
                  Number.isNaN(start.getTime()) ||
                  Number.isNaN(end.getTime()) ||
                  windowMs <= 0 ||
                  windowMs > 31 * 24 * 60 * 60 * 1_000
                ) {
                  setSummaryInputError('Choose a valid window of no more than 31 days.');
                  return;
                }
                summaryWindow = {
                  summaryStart: start.toISOString(),
                  summaryEnd: end.toISOString(),
                };
              }
              const next: SearchRequest = {
                kind,
                value: trimmed,
                status: status === 'all' ? undefined : status,
                closeReason: closeReason === 'all' ? undefined : closeReason,
                skuId: skuId === 'all' ? undefined : skuId,
                ...summaryWindow,
              };
              const submittedValue = submitted.kind === 'recent' ? undefined : submitted.value;
              const nextValue = next.kind === 'recent' ? undefined : next.value;
              const nextSummaryStart =
                next.kind === 'user' || next.kind === 'org' ? next.summaryStart : undefined;
              const nextSummaryEnd =
                next.kind === 'user' || next.kind === 'org' ? next.summaryEnd : undefined;
              const submittedSummaryStart =
                submitted.kind === 'user' || submitted.kind === 'org'
                  ? submitted.summaryStart
                  : undefined;
              const submittedSummaryEnd =
                submitted.kind === 'user' || submitted.kind === 'org'
                  ? submitted.summaryEnd
                  : undefined;
              const unchanged =
                cursor === undefined &&
                submitted.kind === next.kind &&
                submittedValue === nextValue &&
                submitted.status === next.status &&
                submitted.closeReason === next.closeReason &&
                submitted.skuId === next.skuId &&
                submittedSummaryStart === nextSummaryStart &&
                submittedSummaryEnd === nextSummaryEnd;
              setSummaryInputError(null);
              reconciliation.reset();
              setRawResponseOpen(false);
              setRawCopyStatus('idle');
              setSummaryRequest(
                next.kind === 'user' || next.kind === 'org'
                  ? {
                      subjectType: next.kind,
                      subjectId: next.value,
                      start: next.summaryStart ?? '',
                      end: next.summaryEnd ?? '',
                    }
                  : null
              );
              // Sync the URL to the applied filter (not the draft dropdown value) so a
              // submitted search can be bookmarked/deep-linked without re-triggering a
              // search merely from changing the Close reason dropdown before submitting.
              replaceCloseReasonParam(next.closeReason);
              setSubmitted(next);
              resetResultNavigation();
              if (unchanged) void results.refetch();
            }}
          >
            {/* Primary bar: what to search for, and the actions that trigger it.
                items-start (not items-end): every column below shares the same
                label + gap + control rhythm, so their controls line up on the
                same top edge regardless of any incidental height differences
                inside a column (e.g. Radix Select's hidden native <select>). */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="w-full space-y-1.5 sm:w-40 sm:shrink-0">
                <Label htmlFor="usage-search-kind">Search by</Label>
                <Select value={kind} onValueChange={next => setKind(next as SearchKind)}>
                  <SelectTrigger id="usage-search-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="interval">Interval ID</SelectItem>
                    <SelectItem value="user">User ID</SelectItem>
                    <SelectItem value="org">Organization ID</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-full flex-1 space-y-1.5">
                <Label htmlFor="usage-search-value">Exact value</Label>
                <Input
                  id="usage-search-value"
                  value={value}
                  required
                  maxLength={kind === 'interval' ? 512 : 256}
                  placeholder={kind === 'interval' ? 'service:instance:startEpochMs' : 'Exact ID'}
                  onChange={event => setValue(event.target.value)}
                />
              </div>
              <div className="w-full space-y-1.5 sm:w-auto sm:shrink-0">
                <Label className="invisible" aria-hidden="true">
                  Actions
                </Label>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button type="submit" disabled={results.isFetching || !value.trim()}>
                    <Search className="size-4" /> {results.isFetching ? 'Searching...' : 'Search'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setValue('');
                      setStatus('all');
                      setCloseReason('all');
                      setSkuId('all');
                      setSummaryInputError(null);
                      reconciliation.reset();
                      setRawResponseOpen(false);
                      setRawCopyStatus('idle');
                      setSummaryRequest(null);
                      setSubmitted({ kind: 'recent' });
                      replaceCloseReasonParam(undefined);
                      resetResultNavigation();
                    }}
                  >
                    Reset
                  </Button>
                </div>
              </div>
            </div>

            {/* Filters: narrow the search above. Wraps freely; never forces the actions off-card. */}
            <div className="flex flex-wrap items-start gap-4 border-t border-border pt-4">
              <div className="w-36 space-y-1.5">
                <Label htmlFor="usage-search-status">Status</Label>
                <Select
                  value={status}
                  onValueChange={next => {
                    const selected = next as typeof status;
                    setStatus(selected);
                    if (selected === 'open' && closeReason !== 'all') {
                      setCloseReason('all');
                    }
                  }}
                >
                  <SelectTrigger id="usage-search-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-44 space-y-1.5">
                <Label htmlFor="usage-search-close-reason">Close reason</Label>
                <Select
                  value={closeReason}
                  onValueChange={next => {
                    const selected = next as typeof closeReason;
                    const selectedReason = selected === 'all' ? undefined : selected;
                    if (selectedReason && status === 'open') setStatus('closed');
                    setCloseReason(selected);
                  }}
                >
                  <SelectTrigger id="usage-search-close-reason" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any reason</SelectItem>
                    <SelectItem value="exit">Exit</SelectItem>
                    <SelectItem value="runtime_signal">Runtime signal</SelectItem>
                    <SelectItem value="activity_expired">Activity expired</SelectItem>
                    <SelectItem value="unconfirmed">Unconfirmed (15m timeout)</SelectItem>
                    <SelectItem value="superseded">Superseded</SelectItem>
                    <SelectItem value="reconciled">Reconciled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-40 space-y-1.5">
                <Label htmlFor="usage-search-sku">SKU</Label>
                <Select
                  value={skuId}
                  onValueChange={selected => {
                    setSkuId(selected);
                  }}
                >
                  <SelectTrigger id="usage-search-sku" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any SKU</SelectItem>
                    {(catalog.data ?? []).map(sku => (
                      <SelectItem key={sku.id} value={sku.id}>
                        {sku.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(kind === 'user' || kind === 'org') && (
                <div className="w-full space-y-1.5 sm:w-auto">
                  <Label>Usage window</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="usage-summary-start"
                      type="datetime-local"
                      aria-label="Window start"
                      value={summaryStart}
                      max={summaryEnd}
                      aria-describedby={
                        summaryInputError ? 'usage-summary-window-error' : undefined
                      }
                      className="w-full sm:w-[9.5rem]"
                      onChange={event => setSummaryStart(event.target.value)}
                    />
                    <Input
                      id="usage-summary-end"
                      type="datetime-local"
                      aria-label="Window end"
                      value={summaryEnd}
                      min={summaryStart}
                      aria-describedby={
                        summaryInputError ? 'usage-summary-window-error' : undefined
                      }
                      className="w-full sm:w-[9.5rem]"
                      onChange={event => setSummaryEnd(event.target.value)}
                    />
                  </div>
                  {summaryInputError && (
                    <p
                      id="usage-summary-window-error"
                      className="text-destructive type-label"
                      role="alert"
                    >
                      {summaryInputError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {(submitted.kind === 'user' || submitted.kind === 'org') && (
        <Card>
          <CardHeader>
            <CardTitle>Usage summary</CardTitle>
            <CardDescription>
              Accepted seconds and shadow estimated cents for this exact subject. This does not
              debit credits.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {summaryRequest && (
              <p className="text-muted-foreground break-all type-label">
                {summaryRequest.subjectType} {summaryRequest.subjectId} ·{' '}
                {formatTimestamp(summaryRequest.start)} to {formatTimestamp(summaryRequest.end)} ·
                window is [start, end)
              </p>
            )}

            {summary.isFetching && (
              <p className="text-muted-foreground type-body" role="status" aria-live="polite">
                Calculating usage summary...
              </p>
            )}

            {summary.isError && (
              <Alert variant="destructive">
                <AlertTitle>Usage summary could not be calculated</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{summary.error.message}</p>
                  {summary.error.data?.code !== 'BAD_REQUEST' && (
                    <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
                      Retry
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {summary.isSuccess && (
              <div className="space-y-3" aria-live="polite">
                <p className="text-muted-foreground type-label">
                  {summary.data.acceptedSeconds.toLocaleString()} accepted seconds across{' '}
                  {summary.data.items
                    .reduce((total, item) => total + item.intervals, 0)
                    .toLocaleString()}{' '}
                  interval
                  {summary.data.items.reduce((total, item) => total + item.intervals, 0) === 1
                    ? ''
                    : 's'}
                </p>
                {summary.data.items.length === 0 ? (
                  <p className="text-muted-foreground type-body">
                    No accepted usage was recorded in this window.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <caption className="sr-only">
                        Usage summary for {summary.data.subjectType} {summary.data.subjectId} from{' '}
                        {formatTimestamp(summary.data.start)} to {formatTimestamp(summary.data.end)}
                      </caption>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Accepted seconds</TableHead>
                          <TableHead>Rate</TableHead>
                          <TableHead>Estimated cents</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {summary.data.items.map(item => (
                          <TableRow key={item.skuId}>
                            <TableCell>
                              <code className="type-code">{item.skuId}</code>
                              <p className="text-muted-foreground type-label">{item.skuName}</p>
                            </TableCell>
                            <TableCell className="tabular-nums type-code">
                              {item.acceptedSeconds.toLocaleString()}s
                            </TableCell>
                            <TableCell className="tabular-nums type-code">
                              {item.rateCentsPerSecond} cents/s
                            </TableCell>
                            <TableCell className="tabular-nums type-code">
                              {item.estimatedCents} cents
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell className="font-medium">Total</TableCell>
                          <TableCell className="tabular-nums font-medium type-code">
                            {summary.data.acceptedSeconds.toLocaleString()}s
                          </TableCell>
                          <TableCell />
                          <TableCell className="tabular-nums font-medium type-code">
                            {summary.data.estimatedCents} cents
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            {summary.isSuccess && summaryRequest && (
              <div className="space-y-4 border-t border-border pt-4">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="max-w-2xl space-y-1">
                    <h3 className="font-medium type-body">Cloudflare reconciliation</h3>
                    <p className="text-muted-foreground type-label">
                      Query Cloudflare only for physical instance IDs recorded for this applied
                      subject and window. This is shadow validation and does not change usage or
                      billing.
                    </p>
                  </div>
                  <Button
                    type="button"
                    className="w-full sm:w-auto sm:shrink-0"
                    disabled={reconciliation.isPending}
                    onClick={() => reconciliation.mutate(summaryRequest)}
                  >
                    <Cloud className="size-4" />
                    {reconciliation.isPending
                      ? 'Reconciling with Cloudflare...'
                      : 'Reconcile with Cloudflare'}
                  </Button>
                </div>

                {reconciliationMatchesSummary && reconciliation.isError && (
                  <Alert variant="destructive">
                    <AlertTitle>Cloudflare reconciliation could not be completed</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{reconciliation.error.message}</p>
                      {reconciliationCanRetry && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={reconciliation.isPending}
                          onClick={() => reconciliation.mutate(summaryRequest)}
                        >
                          Retry reconciliation
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {reconciliationMatchesSummary && reconciliation.isSuccess && (
                  <div className="space-y-4" aria-live="polite">
                    {reconciliation.data.rows.length === 0 ? (
                      <p className="text-muted-foreground type-body">
                        No accepted meter usage was recorded for this subject in the applied window.
                        Cloudflare was not queried.
                      </p>
                    ) : (
                      <>
                        <p className="text-muted-foreground type-label">
                          {reconciliation.data.comparison.description} Provider CPU is shown only as
                          a diagnostic.
                        </p>

                        <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
                          <div className="bg-surface-inset p-3">
                            <dt className="text-muted-foreground type-label">
                              Meter accepted seconds
                            </dt>
                            <dd className="mt-1 tabular-nums type-code">
                              {reconciliation.data.totals.meterAcceptedSeconds.toLocaleString()}s
                            </dd>
                          </div>
                          <div className="bg-surface-inset p-3">
                            <dt className="text-muted-foreground type-label">
                              Provider comparison seconds
                            </dt>
                            <dd className="mt-1 tabular-nums type-code">
                              {formatProviderNumber(
                                reconciliation.data.totals.providerComparisonSeconds
                              )}
                              {reconciliation.data.totals.providerComparisonSeconds === null
                                ? ''
                                : 's'}
                            </dd>
                          </div>
                          <div className="bg-surface-inset p-3">
                            <dt className="text-muted-foreground type-label">
                              Difference (provider - meter)
                            </dt>
                            <dd className="mt-1 tabular-nums type-code">
                              {formatDifference(
                                reconciliation.data.totals.differenceSeconds,
                                reconciliation.data.totals.differencePercent
                              )}
                            </dd>
                          </div>
                          <div className="bg-surface-inset p-3">
                            <dt className="text-muted-foreground type-label">Instances queried</dt>
                            <dd className="mt-1 tabular-nums type-code">
                              {reconciliation.data.totals.queriedCloudflareInstances.toLocaleString()}
                            </dd>
                          </div>
                        </dl>

                        <p className="text-muted-foreground type-label">
                          {reconciliation.data.counts.matched} matched ·{' '}
                          {reconciliation.data.counts.missing} missing ·{' '}
                          {reconciliation.data.counts.ambiguous} ambiguous ·{' '}
                          {reconciliation.data.counts.partial} partial ·{' '}
                          {reconciliation.data.counts.comparisonUnavailable} comparison unavailable
                        </p>

                        {reconciliation.data.provider.issues.length > 0 && (
                          <Alert variant="warning">
                            <AlertTitle>Cloudflare returned partial data</AlertTitle>
                            <AlertDescription>
                              {reconciliation.data.provider.issues.map(issue => (
                                <p key={issue}>{issue}</p>
                              ))}
                            </AlertDescription>
                          </Alert>
                        )}

                        <div className="overflow-x-auto rounded-lg border border-border">
                          <Table>
                            <caption className="sr-only">
                              Cloudflare reconciliation for {reconciliation.data.subjectType}{' '}
                              {reconciliation.data.subjectId} from{' '}
                              {formatTimestamp(reconciliation.data.start)} to{' '}
                              {formatTimestamp(reconciliation.data.end)}
                            </caption>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Instance</TableHead>
                                <TableHead>Application / service</TableHead>
                                <TableHead>SKU(s)</TableHead>
                                <TableHead>Meter accepted</TableHead>
                                <TableHead>Provider allocation equivalents</TableHead>
                                <TableHead>Difference (provider - meter)</TableHead>
                                <TableHead>Provider CPU</TableHead>
                                <TableHead>Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {reconciliation.data.rows.map(row => (
                                <TableRow
                                  key={`${row.providerInstanceId ?? 'unmapped'}:${row.meterInstanceIds.join(',')}:${row.services.join(',')}`}
                                >
                                  <TableCell>
                                    <code className="block max-w-56 break-all type-code">
                                      {row.instanceId}
                                    </code>
                                    <p className="text-muted-foreground type-label">
                                      {row.intervalCount} interval
                                      {row.intervalCount === 1 ? '' : 's'}
                                    </p>
                                  </TableCell>
                                  <TableCell>
                                    <p className="type-code">
                                      {row.providerApplicationIds.join(', ') || 'No provider match'}
                                    </p>
                                    <p className="text-muted-foreground type-label">
                                      {row.services.join(', ')}
                                    </p>
                                    {row.provisionedMemoryBytes !== null &&
                                      row.provisionedDiskBytes !== null && (
                                        <p className="text-muted-foreground type-label">
                                          {formatProvisionedCapacity(
                                            row.provisionedMemoryBytes,
                                            row.provisionedDiskBytes
                                          )}
                                        </p>
                                      )}
                                  </TableCell>
                                  <TableCell>
                                    <code className="block max-w-56 break-all type-code">
                                      {row.skuIds.join(', ')}
                                    </code>
                                  </TableCell>
                                  <TableCell className="tabular-nums type-code">
                                    {row.meterAcceptedSeconds.toLocaleString()}s
                                  </TableCell>
                                  <TableCell className="tabular-nums type-code">
                                    <span className="block">
                                      Memory {formatProviderNumber(row.providerMemorySeconds)}
                                      {row.providerMemorySeconds === null ? '' : 's'}
                                    </span>
                                    <span className="block text-muted-foreground">
                                      Disk {formatProviderNumber(row.providerDiskSeconds)}
                                      {row.providerDiskSeconds === null ? '' : 's'}
                                    </span>
                                  </TableCell>
                                  <TableCell className="tabular-nums type-code">
                                    {formatDifference(row.differenceSeconds, row.differencePercent)}
                                  </TableCell>
                                  <TableCell className="tabular-nums type-code">
                                    {formatProviderNumber(row.providerCpuTimeSec)}
                                    {row.providerCpuTimeSec === null ? '' : 's'}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant={reconciliationStatusVariant(row.status)}>
                                      {reconciliationStatusLabel(row.status)}
                                    </Badge>
                                    {row.status !== 'comparison_unavailable' && (
                                      <p className="mt-2 min-w-64 text-muted-foreground type-label">
                                        {row.statusDetail}
                                      </p>
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>

                        {reconciliation.data.provider.rawResponses.length > 0 && (
                          <Collapsible
                            open={rawResponseOpen}
                            onOpenChange={open => {
                              setRawResponseOpen(open);
                              setRawCopyStatus('idle');
                            }}
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <CollapsibleTrigger asChild>
                                <Button type="button" variant="outline" size="sm">
                                  <ChevronRight
                                    className={`size-4 transition-transform ${rawResponseOpen ? 'rotate-90' : ''}`}
                                  />
                                  {rawResponseOpen
                                    ? 'Hide raw Cloudflare response'
                                    : 'View raw Cloudflare response'}
                                </Button>
                              </CollapsibleTrigger>
                              {rawResponseOpen && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    if (!navigator.clipboard) {
                                      setRawCopyStatus('failed');
                                      return;
                                    }
                                    const rawJson = JSON.stringify(
                                      reconciliation.data.provider.rawResponses,
                                      null,
                                      2
                                    );
                                    void navigator.clipboard.writeText(rawJson).then(
                                      () => setRawCopyStatus('copied'),
                                      () => setRawCopyStatus('failed')
                                    );
                                  }}
                                >
                                  <Copy className="size-4" /> Copy raw JSON
                                </Button>
                              )}
                              {rawCopyStatus !== 'idle' && (
                                <span
                                  className="text-muted-foreground type-label"
                                  role="status"
                                  aria-live="polite"
                                >
                                  {rawCopyStatus === 'copied' ? 'Raw JSON copied.' : 'Copy failed.'}
                                </span>
                              )}
                            </div>
                            <CollapsibleContent className="mt-3 space-y-3">
                              {reconciliation.data.provider.rawResponses.map((raw, index) => (
                                <section
                                  key={`${raw.dataset}:${raw.windowIndex}:${raw.batchIndex}:${index}`}
                                  className="space-y-2"
                                >
                                  <h4 className="text-muted-foreground type-label">
                                    {raw.dataset} · window {raw.windowIndex + 1} · batch{' '}
                                    {raw.batchIndex + 1}
                                    {raw.window
                                      ? ` · ${formatTimestamp(raw.window.start)} to ${formatTimestamp(raw.window.end)}`
                                      : ''}
                                  </h4>
                                  <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface-inset p-4 whitespace-pre type-code">
                                    {JSON.stringify(raw.body, null, 2)}
                                  </pre>
                                </section>
                              ))}
                            </CollapsibleContent>
                          </Collapsible>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {results.isError && (
        <Alert variant="destructive">
          <AlertTitle>Usage records could not be loaded</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{results.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {results.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle>
              {submitted.kind === 'recent' ? 'Recent usage activity' : 'Usage intervals'}
            </CardTitle>
            <CardDescription>
              {rows.length === 0
                ? submitted.kind === 'recent'
                  ? 'No usage intervals have been recorded yet.'
                  : 'No intervals matched this exact search.'
                : `${rows.length} interval${rows.length === 1 ? '' : 's'} on this page`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <span className="sr-only">Details</span>
                      </TableHead>
                      <TableHead>Interval</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>SKU / status</TableHead>
                      <TableHead>Usage</TableHead>
                      <TableHead>Lifecycle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(interval => {
                      const expanded = expandedId === interval.id;
                      const detailId = `usage-segments-${encodeURIComponent(interval.id)}`;
                      return [
                        <TableRow key={interval.id}>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-expanded={expanded}
                              aria-controls={detailId}
                              aria-label={`${expanded ? 'Hide' : 'Show'} segments for ${interval.id}`}
                              onClick={() => setExpandedId(expanded ? null : interval.id)}
                            >
                              {expanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <div className="max-w-md space-y-1">
                              <code className="break-all type-code">{interval.id}</code>
                              <p className="text-muted-foreground type-label">
                                {interval.service} · {interval.instance_id}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge variant="secondary">{interval.subject_type}</Badge>
                              <Link
                                href={adminSubjectHref(interval.subject_type, interval.subject_id)}
                                className="block break-all rounded-sm font-medium text-link underline decoration-current/40 underline-offset-4 type-code outline-none hover:text-link-hover focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={`View ${interval.subject_type === 'user' ? 'user' : 'organization'} ${interval.subject_id}`}
                              >
                                {interval.subject_id}
                              </Link>
                              <p className="text-muted-foreground type-label">
                                Actor: {interval.actor_type}{' '}
                                {interval.actor_type === 'user' ? (
                                  <Link
                                    href={`/admin/users/${encodeURIComponent(interval.actor_id)}`}
                                    className="rounded-sm text-link underline decoration-current/40 underline-offset-4 outline-none hover:text-link-hover focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={`View user ${interval.actor_id}`}
                                  >
                                    {interval.actor_id}
                                  </Link>
                                ) : (
                                  interval.actor_id
                                )}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <code className="type-code">{interval.cloud_billing_sku_id}</code>
                              <div>
                                <Badge variant={interval.status === 'open' ? 'new' : 'secondary'}>
                                  {interval.status}
                                </Badge>
                              </div>
                              {interval.close_reason && (
                                <p className="text-muted-foreground type-label">
                                  {interval.close_reason}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums">
                            <p className="type-code">{interval.confirmed_seconds}s</p>
                            <p className="text-muted-foreground type-label">
                              Seq {interval.last_heartbeat_seq}
                            </p>
                          </TableCell>
                          <TableCell className="min-w-52">
                            <p className="type-label">
                              Started {formatTimestamp(interval.started_at)}
                            </p>
                            <p className="text-muted-foreground type-label">
                              Last seen {formatTimestamp(interval.last_seen_at)}
                            </p>
                            {interval.stopped_at && (
                              <p className="text-muted-foreground type-label">
                                Stopped {formatTimestamp(interval.stopped_at)}
                              </p>
                            )}
                          </TableCell>
                        </TableRow>,
                        expanded ? (
                          <TableRow key={`${interval.id}-details`}>
                            <TableCell id={detailId} colSpan={6} className="bg-surface-inset p-4">
                              <SegmentDetails intervalId={interval.id} />
                            </TableCell>
                          </TableRow>
                        ) : null,
                      ];
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={previousCursors.length === 0 || results.isFetching}
                onClick={() => {
                  const previous = [...previousCursors];
                  setCursor(previous.pop());
                  setPreviousCursors(previous);
                  setExpandedId(null);
                }}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={!results.data.nextCursor || results.isFetching}
                onClick={() => {
                  if (!results.data.nextCursor) return;
                  setPreviousCursors(current => [...current, cursor]);
                  setCursor(results.data.nextCursor);
                  setExpandedId(null);
                }}
              >
                Older
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
