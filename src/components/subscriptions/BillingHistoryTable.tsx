import type { BillingHistoryEntry } from '@/lib/subscriptions/subscription-center';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCents, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

function formatCreditAmount(amountMicrodollars: number): string {
  return `$${(amountMicrodollars / 1_000_000).toFixed(2)}`;
}

export function BillingHistoryTable({
  variant,
  entries,
  hasMore,
  onLoadMore,
  isLoading = false,
}: {
  variant: 'stripe' | 'credits';
  entries: BillingHistoryEntry[];
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
              {variant === 'stripe' ? (
                <TableHead>Amount</TableHead>
              ) : (
                <TableHead>Description</TableHead>
              )}
              <TableHead>{variant === 'stripe' ? 'Status' : 'Amount'}</TableHead>
              {variant === 'stripe' ? <TableHead>Invoice</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={variant === 'stripe' ? 4 : 3}
                  className="text-muted-foreground py-8 text-center"
                >
                  No billing history yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell>{formatIsoDateString_UsaDateOnlyFormat(entry.date)}</TableCell>
                  {entry.kind === 'stripe' ? (
                    <>
                      <TableCell>{formatCents(entry.amountCents, entry.currency)}</TableCell>
                      <TableCell className="capitalize">
                        {entry.status.replace(/_/g, ' ')}
                      </TableCell>
                      <TableCell>
                        {entry.invoiceUrl ? (
                          <a
                            href={entry.invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            View
                          </a>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>{entry.description}</TableCell>
                      <TableCell>{formatCreditAmount(entry.amountMicrodollars)}</TableCell>
                    </>
                  )}
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
