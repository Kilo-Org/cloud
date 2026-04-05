'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BooleanBadge } from '@/components/ui/boolean-badge';
import { useQuery } from '@tanstack/react-query';
import type { UserDetailProps } from '@/types/admin';
import type { credit_transactions } from '@kilocode/db/schema';
import { ExternalLinkIcon } from 'lucide-react';

type CreditTransaction = typeof credit_transactions.$inferSelect;

export function UserAdminCreditTransactions({ id }: UserDetailProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-user-credit-transactions', id],
    queryFn: async (): Promise<{ credit_transactions: CreditTransaction[] }> => {
      const response = await fetch(`/admin/api/users/credit-transactions?kilo_user_id=${id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch credit transactions');
      }
      return response.json() as Promise<{ credit_transactions: CreditTransaction[] }>;
    },
  });

  const creditTransactions = data?.credit_transactions || [];

  const totalMicrodollars = creditTransactions.reduce((sum, tx) => sum + tx.amount_microdollars, 0);

  const formatAmount = (amountMicrodollars: number) => {
    return `$${(amountMicrodollars / 1_000_000).toFixed(2)}`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStripePaymentUrl = (stripePaymentId: string) => {
    return `https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}payments/${stripePaymentId}`;
  };

  return (
    <Card className="max-h-max lg:col-span-2 lg:row-span-2">
      <CardHeader>
        <CardTitle>Credit Transaction History</CardTitle>
        <CardDescription>All credit transactions for this user</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading credit transactions...</p>
        ) : error ? (
          <p className="text-sm text-red-600">Failed to load credit transactions</p>
        ) : creditTransactions.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Total transactions: {creditTransactions.length} ({formatAmount(totalMicrodollars)})
            </p>
            <div className="bg-muted/50 rounded-md border">
              <div className="space-y-0">
                {creditTransactions.map(transaction => (
                  <div
                    key={transaction.id}
                    className="border-muted/30 border-b p-3 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <BooleanBadge positive={transaction.amount_microdollars > 0}>
                            {transaction.amount_microdollars > 0 ? '+' : ''}
                            {formatAmount(transaction.amount_microdollars)}
                          </BooleanBadge>
                          {transaction.is_free && (
                            <Badge variant="secondary" className="text-xs">
                              Free
                            </Badge>
                          )}
                          {transaction.credit_category && (
                            <Badge variant="outline" className="text-xs">
                              {transaction.credit_category}
                            </Badge>
                          )}
                          <span className="text-muted-foreground ml-auto text-xs">
                            {transaction.id}
                          </span>
                        </div>
                        {transaction.description && (
                          <p className="text-muted-foreground mb-1 text-sm">
                            {transaction.description}
                          </p>
                        )}
                        <div className="text-muted-foreground flex items-center gap-4 text-xs">
                          <span>{formatDate(transaction.created_at)}</span>
                          {transaction.expiry_date && (
                            <span className="text-foreground">
                              Expires: {formatDate(transaction.expiry_date)}
                            </span>
                          )}
                          {transaction.expiration_baseline_microdollars_used != null && (
                            <span>
                              Baseline:{' '}
                              {formatAmount(transaction.expiration_baseline_microdollars_used)}
                            </span>
                          )}
                          {transaction.stripe_payment_id && (
                            <a
                              href={getStripePaymentUrl(transaction.stripe_payment_id)}
                              target="_blank"
                              className="flex items-center gap-1 text-blue-600 underline hover:text-blue-300"
                            >
                              View in Stripe
                              <ExternalLinkIcon className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No credit transactions found for this user.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
