'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Download, Receipt } from 'lucide-react';
import { formatCents, formatDate } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';

type UserAdminInvoicesProps = {
  stripe_customer_id: string;
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'paid':
      return 'bg-green-900/20 text-green-400';
    case 'open':
    case 'issued':
      return 'bg-yellow-900/20 text-yellow-400';
    case 'draft':
      return 'bg-gray-800 text-gray-300';
    case 'void':
      return 'bg-red-900/20 text-red-400';
    default:
      return 'bg-gray-800 text-gray-300';
  }
};

export function UserAdminInvoices({ stripe_customer_id }: UserAdminInvoicesProps) {
  const trpc = useTRPC();
  const { data, isLoading, error } = useQuery(
    trpc.admin.users.getInvoices.queryOptions({ stripe_customer_id })
  );

  const invoices = data?.invoices ?? [];

  return (
    <Card className="max-h-max lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5" /> Invoices
        </CardTitle>
        <CardDescription>
          All invoices for this user from Stripe (same as user sees in their billing page)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading invoices...</p>
        ) : error ? (
          <p className="text-sm text-red-600">Failed to load invoices</p>
        ) : invoices.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">Total: {invoices.length}</p>
            <div className="bg-muted/50 rounded-md border">
              <div className="space-y-0">
                {invoices.map(invoice => (
                  <div
                    key={invoice.id}
                    className="border-muted/30 flex flex-wrap items-center justify-between gap-2 border-b p-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {invoice.number || `Invoice ${invoice.id.slice(-8)}`}
                      </p>
                      <p className="text-muted-foreground text-xs">{formatDate(invoice.created)}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">
                        {formatCents(invoice.amount_due, invoice.currency)}
                      </span>

                      <Badge className={getStatusColor(invoice.status)}>
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </Badge>

                      {invoice.invoice_type && (
                        <Badge variant="secondary" className="text-xs">
                          {invoice.invoice_type === 'seats' ? 'Seats' : 'Top-up'}
                        </Badge>
                      )}

                      {invoice.hosted_invoice_url && (
                        <Button asChild variant="outline" size="sm">
                          <a
                            href={invoice.hosted_invoice_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="mr-1 h-3 w-3" />
                            View
                          </a>
                        </Button>
                      )}

                      {invoice.invoice_pdf && (
                        <Button asChild variant="outline" size="sm">
                          <a href={invoice.invoice_pdf} target="_blank" rel="noopener noreferrer">
                            <Download className="mr-1 h-3 w-3" />
                            PDF
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No invoices found for this user.</p>
        )}
      </CardContent>
    </Card>
  );
}
