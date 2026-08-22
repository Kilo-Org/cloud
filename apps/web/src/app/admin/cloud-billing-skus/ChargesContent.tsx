'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMicrodollars } from '@/lib/cloud-billing-sku';
import { useTRPC } from '@/lib/trpc/utils';

type ChargeFilters = {
  userId: string;
  organizationId: string;
  intervalId: string;
  sessionId: string;
  skuId: string;
  start: string;
  end: string;
};
type ChargeCursor = { createdAt: string; usageSource: string; usageSourceId: string };

export function toDateTimeLocalValue(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

export function validateChargeFilters(filters: ChargeFilters): {
  value?: ChargeFilters & { startIso: string; endIso: string };
  error?: string;
} {
  if (filters.userId.trim() && filters.organizationId.trim())
    return { error: 'Filter by either a user or an organization, not both.' };
  if (!filters.start || !filters.end) return { error: 'Choose both a From and To date.' };
  const start = new Date(filters.start);
  const end = new Date(filters.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return { error: 'Choose valid From and To dates.' };
  if (end <= start) return { error: 'To must be after From.' };
  if (end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1_000)
    return { error: 'Charge windows may not exceed 31 days.' };
  return { value: { ...filters, startIso: start.toISOString(), endIso: end.toISOString() } };
}

export function usageIntervalHref(intervalId: string): string {
  return `/admin/cloud-billing-skus?tab=usage-records&intervalId=${encodeURIComponent(intervalId)}`;
}

export default function ChargesContent() {
  const trpc = useTRPC();
  const [filters, setFilters] = useState<ChargeFilters>(() => ({
    userId: '',
    organizationId: '',
    intervalId: '',
    sessionId: '',
    skuId: '',
    start: toDateTimeLocalValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000)),
    end: toDateTimeLocalValue(new Date()),
  }));
  const [applied, setApplied] = useState(() => validateChargeFilters(filters).value);
  const [formError, setFormError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<ChargeCursor>();
  const [previousCursors, setPreviousCursors] = useState<Array<ChargeCursor | undefined>>([]);
  const query = useQuery({
    ...trpc.admin.cloudBillingSkus.searchUsageCharges.queryOptions({
      userId: applied?.userId.trim() || undefined,
      organizationId: applied?.organizationId.trim() || undefined,
      intervalId: applied?.intervalId.trim() || undefined,
      sessionId: applied?.sessionId.trim() || undefined,
      skuId: applied?.skuId.trim() || undefined,
      start: applied?.startIso ?? new Date(0).toISOString(),
      end: applied?.endIso ?? new Date(1).toISOString(),
      cursor,
      limit: 25,
    }),
    enabled: applied !== undefined,
  });
  const rows = query.data?.items ?? [];
  const setFilter = <K extends keyof ChargeFilters>(key: K, value: ChargeFilters[K]) =>
    setFilters(current => ({ ...current, [key]: value }));
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Charge ledger</CardTitle>
          <CardDescription>
            Immutable settled compute debits. Amounts are read-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            onSubmit={event => {
              event.preventDefault();
              const result = validateChargeFilters(filters);
              if (!result.value) {
                setFormError(result.error ?? 'Invalid filters.');
                return;
              }
              setFormError(null);
              setApplied(result.value);
              setCursor(undefined);
              setPreviousCursors([]);
            }}
          >
            {(
              [
                ['userId', 'User ID'],
                ['organizationId', 'Organization ID'],
                ['intervalId', 'Interval ID'],
                ['sessionId', 'Cloud Agent session ID'],
                ['skuId', 'SKU'],
              ] as const
            ).map(([key, label]) => (
              <div className="space-y-1.5" key={key}>
                <Label htmlFor={`charge-${key}`}>{label}</Label>
                <Input
                  id={`charge-${key}`}
                  value={filters[key]}
                  onChange={event => setFilter(key, event.target.value)}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="charge-start">From</Label>
              <Input
                id="charge-start"
                type="datetime-local"
                required
                value={filters.start}
                max={filters.end}
                aria-describedby={formError ? 'charge-filter-error' : undefined}
                className="cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                onClick={event => event.currentTarget.showPicker?.()}
                onChange={event => setFilter('start', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="charge-end">To</Label>
              <Input
                id="charge-end"
                type="datetime-local"
                required
                value={filters.end}
                min={filters.start}
                aria-describedby={formError ? 'charge-filter-error' : undefined}
                className="cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                onClick={event => event.currentTarget.showPicker?.()}
                onChange={event => setFilter('end', event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={query.isFetching}>
                {query.isFetching ? 'Loading...' : 'Apply filters'}
              </Button>
            </div>
            {formError && (
              <p
                id="charge-filter-error"
                className="text-destructive sm:col-span-2 xl:col-span-4 type-label"
                role="alert"
              >
                {formError}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      {query.isError && (
        <Alert variant="destructive">
          <AlertTitle>Charges could not be loaded</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{query.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {query.isLoading ? (
        <p className="text-muted-foreground type-body" role="status">
          Loading charges...
        </p>
      ) : (
        query.isSuccess && (
          <Card>
            <CardHeader>
              <CardTitle>Charges</CardTitle>
              <CardDescription>
                {rows.length === 0
                  ? 'No charges matched this bounded search.'
                  : `${rows.length} charge${rows.length === 1 ? '' : 's'} on this page`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {rows.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created / payer</TableHead>
                        <TableHead>Service / interval</TableHead>
                        <TableHead>SKU / source</TableHead>
                        <TableHead>Quantity / rate</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(row => (
                        <TableRow
                          key={`${row.usage_source}:${row.usage_source_id}:${row.created_at}`}
                        >
                          <TableCell>
                            <p className="tabular-nums type-label">
                              {new Date(row.created_at).toLocaleString()}
                            </p>
                            <Link
                              href={
                                row.payer_type === 'user'
                                  ? `/admin/users/${encodeURIComponent(row.payer_id)}`
                                  : `/admin/organizations/${encodeURIComponent(row.payer_id)}`
                              }
                              className="break-all text-link underline decoration-current/40 underline-offset-4 type-code"
                            >
                              {row.payer_type} · {row.payer_id}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <p className="type-code">{row.service ?? '—'}</p>
                            {row.interval_id && (
                              <Link
                                href={usageIntervalHref(row.interval_id)}
                                className="break-all text-link underline decoration-current/40 underline-offset-4 type-code"
                              >
                                {row.interval_id}
                              </Link>
                            )}
                            {row.session_id && (
                              <Link
                                href={`/admin/session-traces?sessionId=${encodeURIComponent(row.session_id)}`}
                                className="block break-all text-link underline decoration-current/40 underline-offset-4 type-code"
                              >
                                {row.session_id}
                              </Link>
                            )}
                          </TableCell>
                          <TableCell>
                            <code className="type-code">{row.cloud_billing_sku_id}</code>
                            <p className="text-muted-foreground break-all type-label">
                              {row.usage_source} · {row.usage_source_id}
                            </p>
                          </TableCell>
                          <TableCell className="tabular-nums type-code">
                            {row.quantity}
                            <p className="text-muted-foreground type-label">
                              {row.rate_cents_per_unit} cents/unit
                            </p>
                          </TableCell>
                          <TableCell className="text-right tabular-nums type-code">
                            {formatMicrodollars(row.amount_microdollars)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={previousCursors.length === 0 || query.isFetching}
                  onClick={() => {
                    const previous = [...previousCursors];
                    setCursor(previous.pop());
                    setPreviousCursors(previous);
                  }}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={!query.data.nextCursor || query.isFetching}
                  onClick={() => {
                    if (!query.data.nextCursor) return;
                    setPreviousCursors(current => [...current, cursor]);
                    setCursor(query.data.nextCursor);
                  }}
                >
                  Older
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      )}
    </div>
  );
}
