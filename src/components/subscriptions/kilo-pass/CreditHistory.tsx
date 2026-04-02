'use client';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

type CreditHistoryEntry = {
  id: string;
  date: string;
  amountUsd: number;
  kind: string;
  description: string;
};

export function CreditHistory({
  entries,
  hasMore,
  onLoadMore,
  isLoading = false,
}: {
  entries: CreditHistoryEntry[];
  hasMore: boolean;
  onLoadMore: () => void;
  isLoading?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                  No credit issuances yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell>{formatIsoDateString_UsaDateOnlyFormat(entry.date)}</TableCell>
                  <TableCell className="capitalize">{entry.kind.replace(/_/g, ' ')}</TableCell>
                  <TableCell>{formatDollars(entry.amountUsd)}</TableCell>
                  <TableCell>{entry.description}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {hasMore ? (
        <Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
