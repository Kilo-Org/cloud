'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
      kind: SearchKind;
      value: string;
      status?: 'open' | 'closed';
      closeReason?: CloseReason;
      skuId?: string;
    };
type Cursor = { startedAt: string; id: string };

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
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
            } as const),
    status: submitted.status,
    closeReason: submitted.closeReason,
    skuId: submitted.skuId,
    cursor,
    limit: submitted.kind === 'recent' ? 10 : 25,
  };
  const results = useQuery(trpc.admin.cloudBillingSkus.searchUsageIntervals.queryOptions(input));
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
            className="grid gap-4 lg:grid-cols-3 lg:items-start xl:grid-cols-[9rem_minmax(12.5rem,1fr)_7rem_10rem_10rem_auto] xl:gap-3"
            onSubmit={event => {
              event.preventDefault();
              const trimmed = value.trim();
              if (!trimmed) return;
              const next: SearchRequest = {
                kind,
                value: trimmed,
                status: status === 'all' ? undefined : status,
                closeReason: closeReason === 'all' ? undefined : closeReason,
                skuId: skuId === 'all' ? undefined : skuId,
              };
              const unchanged =
                cursor === undefined &&
                submitted.kind === next.kind &&
                submitted.value === next.value &&
                submitted.status === next.status &&
                submitted.closeReason === next.closeReason &&
                submitted.skuId === next.skuId;
              setSubmitted(next);
              resetResultNavigation();
              if (unchanged) void results.refetch();
            }}
          >
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <Label htmlFor="usage-search-status">Status</Label>
              <Select
                value={status}
                onValueChange={next => {
                  const selected = next as typeof status;
                  const selectedStatus = selected === 'all' ? undefined : selected;
                  const selectedCloseReason =
                    selected === 'open' ? undefined : submitted.closeReason;
                  setStatus(selected);
                  if (selected === 'open' && closeReason !== 'all') {
                    setCloseReason('all');
                    replaceCloseReasonParam(undefined);
                  }
                  setSubmitted(current => ({
                    ...current,
                    status: selectedStatus,
                    closeReason: selectedCloseReason,
                  }));
                  resetResultNavigation();
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
            <div className="space-y-1.5">
              <Label htmlFor="usage-search-close-reason">Close reason</Label>
              <Select
                value={closeReason}
                onValueChange={next => {
                  const selected = next as typeof closeReason;
                  const selectedReason = selected === 'all' ? undefined : selected;
                  if (selectedReason && status === 'open') setStatus('closed');
                  setCloseReason(selected);
                  replaceCloseReasonParam(selectedReason);
                  setSubmitted(current => ({
                    ...current,
                    status: selectedReason && current.status === 'open' ? 'closed' : current.status,
                    closeReason: selectedReason,
                  }));
                  resetResultNavigation();
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
            <div className="space-y-1.5">
              <Label htmlFor="usage-search-sku">SKU</Label>
              <Select
                value={skuId}
                onValueChange={selected => {
                  setSkuId(selected);
                  setSubmitted(current => ({
                    ...current,
                    skuId: selected === 'all' ? undefined : selected,
                  }));
                  resetResultNavigation();
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
            <div className="space-y-1.5">
              <Label className="invisible" aria-hidden="true">
                Action
              </Label>
              <Button
                type="submit"
                className="w-full"
                disabled={results.isFetching || !value.trim()}
              >
                <Search className="size-4" /> {results.isFetching ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

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
