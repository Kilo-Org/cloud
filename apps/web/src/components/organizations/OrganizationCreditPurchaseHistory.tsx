'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function OrganizationCreditPurchaseHistory({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const [cursor, setCursor] = useState(0);
  const history = useQuery(
    trpc.user.getCreditPurchaseHistory.queryOptions({ organizationId, cursor })
  );
  const receipt = useMutation(trpc.user.getCreditPurchaseReceipt.mutationOptions());

  const openReceipt = async (transactionId: string) => {
    try {
      const result = await receipt.mutateAsync({ organizationId, transactionId });
      if (result.url) window.location.assign(result.url);
      else toast.error('Invoice is unavailable for this purchase.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the invoice.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit purchase history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {history.isPending ? (
          <p className="text-muted-foreground text-sm">Loading credit purchases...</p>
        ) : history.isError ? (
          <div className="space-y-2">
            <p className="text-destructive text-sm">Could not load credit purchases.</p>
            <Button variant="outline" onClick={() => void history.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchase date</TableHead>
                <TableHead>Credits added</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.entries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell>{new Date(entry.date).toLocaleDateString('en-US')}</TableCell>
                  <TableCell>{formatMicrodollars(entry.amount_mUsd)}</TableCell>
                  <TableCell>
                    {entry.expiryDate
                      ? new Date(entry.expiryDate).toLocaleString('en-US', {
                          timeZone: 'UTC',
                          timeZoneName: 'short',
                        })
                      : 'Does not expire'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      disabled={receipt.isPending}
                      onClick={() => void openReceipt(entry.id)}
                    >
                      {receipt.isPending && receipt.variables?.transactionId === entry.id
                        ? 'Opening invoice...'
                        : 'View invoice'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {history.data.entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground text-center">
                    No credit purchases yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {history.data &&
          (history.data.previousCursor !== null || history.data.nextCursor !== null) && (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={history.data.previousCursor === null}
                onClick={() => setCursor(history.data?.previousCursor ?? cursor)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={history.data.nextCursor === null}
                onClick={() => setCursor(history.data?.nextCursor ?? cursor)}
              >
                Next
              </Button>
            </div>
          )}
      </CardContent>
    </Card>
  );
}
