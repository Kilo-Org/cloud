import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BooleanBadge } from '@/components/ui/boolean-badge';
import {
  useOrganizationCreditTransactions,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import { FormattedMicrodollars } from '@/components/organizations/FormattedMicrodollars';
import { Button } from '@/components/ui/button';
import { Loader2, Receipt } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { formatRelativeTime } from '@/lib/admin-utils';

export function OrganizationAdminCreditTransactions({
  organizationId,
}: {
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { data: orgData } = useOrganizationWithMembers(organizationId);

  const invalidateOrgCreditQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.organizations.withMembers.queryKey({ organizationId }),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.organizations.creditTransactions.queryKey({ organizationId }),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.organizations.getCreditBlocks.queryKey({ organizationId }),
    });
  };

  const consumeCreditsMutation = useMutation({
    mutationFn: async (amount_usd: number) => {
      const response = await fetch(
        `/admin/api/organizations/${encodeURIComponent(organizationId)}/consume-credits`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_usd }),
        }
      );
      if (!response.ok) {
        const data: { error?: string } = await response.json();
        throw new Error(data.error || 'Failed to consume credits');
      }
    },
    onSuccess: () => {
      invalidateOrgCreditQueries();
      toast.success('Credits consumed');
    },
    onError: err => {
      toast.error(`Failed: ${err.message}`);
    },
  });

  const forceExpirationMutation = useMutation<void, Error>({
    mutationFn: async () => {
      const response = await fetch(
        `/admin/api/organizations/${encodeURIComponent(organizationId)}/force-expiration-check`,
        { method: 'POST' }
      );
      if (!response.ok) {
        const data: { error?: string } = await response.json();
        throw new Error(data.error || 'Failed to force expiration check');
      }
    },
    onSuccess: () => {
      invalidateOrgCreditQueries();
      toast.success('Expiration check completed');
    },
    onError: err => {
      toast.error(`Failed: ${err.message}`);
    },
  });

  const {
    data: credit_transactions = [],
    isLoading,
    error,
    refetch,
  } = useOrganizationCreditTransactions(organizationId);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return <LoadingCard title="Credit Transactions" description="Loading credit transactions..." />;
  }

  if (error) {
    return (
      <ErrorCard
        title="Credit Transactions"
        description="Error loading credit transactions"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            <Receipt className="mr-2 inline h-5 w-5" />
            Credit Transactions ({credit_transactions.length})
          </CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs">
              Next expiration:{' '}
              {orgData?.next_credit_expiration_at
                ? formatRelativeTime(orgData.next_credit_expiration_at)
                : 'None'}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => forceExpirationMutation.mutate()}
              disabled={forceExpirationMutation.isPending}
            >
              {forceExpirationMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Recomputing...
                </>
              ) : (
                'Recompute & check expirations'
              )}
            </Button>
            {process.env.NODE_ENV === 'development' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const input = window.prompt('Amount to consume (USD):');
                  if (input) {
                    const amount = parseFloat(input);
                    if (!isNaN(amount) && amount > 0) {
                      consumeCreditsMutation.mutate(amount);
                    }
                  }
                }}
                disabled={consumeCreditsMutation.isPending}
              >
                {consumeCreditsMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Consuming...
                  </>
                ) : (
                  'Consume Credits (Dev)'
                )}
              </Button>
            )}
          </div>
        </div>
        <CardDescription>Recent credit transactions for this organization</CardDescription>
      </CardHeader>
      <CardContent>
        {credit_transactions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No credit transactions found</p>
        ) : (
          <div className="space-y-4">
            {credit_transactions.slice(0, 10).map(transaction => (
              <div
                key={transaction.id}
                className="flex items-center justify-between border-b pb-4 last:border-b-0"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <BooleanBadge positive={transaction.amount_microdollars > 0}>
                      {transaction.amount_microdollars > 0 ? '+' : ''}
                      <FormattedMicrodollars
                        microdollars={transaction.amount_microdollars}
                        className="inline whitespace-nowrap"
                        inline={true}
                        decimalPlaces={2}
                      />
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
                  </div>
                  {transaction.description && (
                    <p className="text-muted-foreground text-sm">{transaction.description}</p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    {formatDate(transaction.created_at)}
                  </p>
                  {transaction.expiry_date && (
                    <p className="text-muted-foreground text-xs">
                      Expires: {formatDate(transaction.expiry_date)}
                    </p>
                  )}
                </div>
                <div className="text-muted-foreground text-right text-xs">
                  <p>ID: {transaction.id.slice(0, 8)}...</p>
                  {transaction.stripe_payment_id && (
                    <p title={transaction.stripe_payment_id}>
                      Stripe: {transaction.stripe_payment_id}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {credit_transactions.length > 10 && (
              <p className="text-muted-foreground text-center text-sm">
                Showing 10 of {credit_transactions.length} transactions
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
