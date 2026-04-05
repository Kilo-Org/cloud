'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type SeatPurchasesTableProps = {
  organizationId: string;
};

export function SeatPurchasesTable({ organizationId }: SeatPurchasesTableProps) {
  const trpc = useTRPC();
  const { data, isLoading, error, refetch } = useQuery(
    trpc.organizations.seatPurchases.queryOptions({ organizationId })
  );

  if (isLoading) {
    return (
      <LoadingCard title="Seat Purchases History" description="Loading seat purchase records..." />
    );
  }

  if (error) {
    return (
      <ErrorCard
        title="Seat Purchases History"
        description="Error loading seat purchase records"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  const seatPurchases = data?.seatPurchases || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seat Purchases History</CardTitle>
        <CardDescription>
          Complete history of seat purchases for this organization (Admin Only)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {seatPurchases.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">
            No seat purchases found for this organization.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Purchase Date</TableHead>
                  <TableHead>Seats</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Stripe Subscription</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {seatPurchases.map(purchase => {
                  const isExpired = new Date(purchase.expires_at) < new Date();
                  const createdAt = new Date(purchase.created_at);
                  const expiresAt = new Date(purchase.expires_at);

                  return (
                    <TableRow key={purchase.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{createdAt.toLocaleDateString()}</span>
                          <span className="text-muted-foreground text-sm">
                            {formatDistanceToNow(createdAt, { addSuffix: true })}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{purchase.seat_count} seats</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">${purchase.amount_usd.toFixed(2)}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className={isExpired ? 'text-red-600' : 'text-green-600'}>
                            {expiresAt.toLocaleDateString()}
                          </span>
                          <Badge variant={isExpired ? 'destructive' : 'default'} className="w-fit">
                            {isExpired ? 'Expired' : 'Active'}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="bg-muted rounded px-2 py-1 text-xs">
                          {purchase.subscription_stripe_id}
                        </code>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
