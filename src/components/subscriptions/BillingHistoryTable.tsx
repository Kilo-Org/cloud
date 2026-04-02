import type { BillingHistoryEntry } from '@/lib/subscriptions/subscription-center';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatCents, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

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
  const headerCellClassName = 'h-14 bg-muted/20 px-4 text-sm font-semibold';
  const bodyCellClassName = 'px-4 py-4';

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted/20">
            <TableRow className="hover:bg-transparent">
              <TableHead className={headerCellClassName}>Date</TableHead>
              {variant === 'stripe' ? (
                <TableHead className={headerCellClassName}>Amount</TableHead>
              ) : (
                <TableHead className={headerCellClassName}>Description</TableHead>
              )}
              <TableHead className={headerCellClassName}>
                {variant === 'stripe' ? 'Status' : 'Amount'}
              </TableHead>
              {variant === 'stripe' ? (
                <TableHead className={headerCellClassName}>Invoice</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={variant === 'stripe' ? 4 : 3}
                  className="text-muted-foreground px-4 py-10 text-center"
                >
                  No billing history yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell className={bodyCellClassName}>
                    {formatIsoDateString_UsaDateOnlyFormat(entry.date)}
                  </TableCell>
                  {entry.kind === 'stripe' ? (
                    <>
                      <TableCell className={bodyCellClassName}>
                        {formatCents(entry.amountCents, entry.currency)}
                      </TableCell>
                      <TableCell className={bodyCellClassName}>
                        <InvoiceStatusBadge status={entry.status} />
                      </TableCell>
                      <TableCell className={bodyCellClassName}>
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
                      <TableCell className={bodyCellClassName}>{entry.description}</TableCell>
                      <TableCell className={bodyCellClassName}>
                        {formatCreditAmount(entry.amountMicrodollars)}
                      </TableCell>
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

function InvoiceStatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, ' ');
  const colorClass =
    status === 'paid'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : status === 'open'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : status === 'draft'
          ? 'border-muted-foreground/30 bg-muted/20 text-muted-foreground'
          : status === 'void' || status === 'uncollectible'
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : 'border-muted-foreground/30 bg-muted/20 text-muted-foreground';

  return (
    <Badge variant="outline" className={cn('capitalize', colorClass)}>
      {label}
    </Badge>
  );
}
