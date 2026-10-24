'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { DateRange } from './hooks';

export function ComputeUsageSection({
  organizationId,
  view,
  dateRange,
}: {
  organizationId: string | null;
  view: 'self' | 'all';
  dateRange: DateRange;
}) {
  const trpc = useTRPC();
  const [groupBy, setGroupBy] = useState<'day' | 'session'>('day');
  const [page, setPage] = useState(0);
  const charges = useQuery(
    trpc.computeBilling.charges.queryOptions({
      ...(organizationId ? { organizationId } : {}),
      view,
      ...dateRange,
      groupBy,
      page,
    })
  );
  const payerLabel = organizationId ? 'Organization' : 'Personal account';
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 sm:flex-row">
        <div className="space-y-1.5">
          <CardTitle>
            {organizationId ? 'Organization compute charges' : 'Personal compute charges'}
          </CardTitle>
          <CardDescription>
            Paid by: {payerLabel}. Model charges appear separately below. Dates use UTC.
          </CardDescription>
        </div>
        <Select
          value={groupBy}
          onValueChange={value => {
            setGroupBy(value as 'day' | 'session');
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="Group compute charges" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">By day</SelectItem>
            <SelectItem value="session">By session</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        {charges.isError ? (
          <div role="alert" className="flex items-center justify-between gap-3">
            <p>Compute charges could not load.</p>
            <Button variant="outline" onClick={() => void charges.refetch()}>
              Retry
            </Button>
          </div>
        ) : charges.isPending ? (
          <p role="status">Loading compute charges…</p>
        ) : charges.data.rows.length === 0 ? (
          <p className="text-muted-foreground">No compute charges in this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{groupBy === 'day' ? 'Date' : 'First charge'}</TableHead>
                {groupBy === 'session' && <TableHead>Session</TableHead>}
                {organizationId && <TableHead>Member</TableHead>}
                <TableHead>Compute</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {charges.data.rows.map((row, index) => (
                <TableRow key={index}>
                  <TableCell className="whitespace-nowrap">{row.day}</TableCell>
                  {groupBy === 'session' && (
                    <TableCell className="max-w-64 break-all text-xs">
                      {row.sessionId ?? 'Shared or unassigned compute'}
                    </TableCell>
                  )}
                  {organizationId && (
                    <TableCell>{row.memberName ?? row.memberId ?? 'Unassigned'}</TableCell>
                  )}
                  <TableCell className="max-w-64 break-words">{row.skuName}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {row.seconds.toLocaleString()} seconds
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatComputePrice(row.rateCentsPerSecond * 36)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    ${(row.amountMicrodollars / 1_000_000).toFixed(6)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-end gap-3">
          <span className="text-muted-foreground text-sm">Page {page + 1} · Up to 100 rows</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || charges.isFetching}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!charges.data?.hasMore || charges.isFetching}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
