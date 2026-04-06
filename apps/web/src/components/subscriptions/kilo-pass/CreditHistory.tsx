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

const TIER_DISPLAY_NAMES: Record<string, string> = {
  tier_19: 'Starter',
  tier_49: 'Pro',
  tier_199: 'Expert',
};

function humanizeCreditDescription(description: string): string {
  return description.replace(/tier_\d+/g, match => TIER_DISPLAY_NAMES[match] ?? match);
}

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
  const headerCellClassName = 'h-14 bg-muted/20 px-4 text-sm font-semibold';
  const bodyCellClassName = 'px-4 py-4';

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted/20">
            <TableRow className="hover:bg-transparent">
              <TableHead className={headerCellClassName}>Date</TableHead>
              <TableHead className={headerCellClassName}>Type</TableHead>
              <TableHead className={headerCellClassName}>Amount</TableHead>
              <TableHead className={headerCellClassName}>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground px-4 py-10 text-center">
                  No credit issuances yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell className={bodyCellClassName}>
                    {formatIsoDateString_UsaDateOnlyFormat(entry.date)}
                  </TableCell>
                  <TableCell className={`${bodyCellClassName} capitalize`}>
                    {entry.kind.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className={bodyCellClassName}>
                    {formatDollars(entry.amountUsd)}
                  </TableCell>
                  <TableCell className={bodyCellClassName}>
                    {humanizeCreditDescription(entry.description)}
                  </TableCell>
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
