'use client';

import { useOrganizationInvoices } from '@/app/api/organizations/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, FileText, DollarSign } from 'lucide-react';
import type { UnifiedInvoice } from '@/types/billing';

type Props = {
  organizationId: string;
  timePeriod?: string;
};

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100); // Stripe amounts are in cents
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function InvoiceRow({ invoice }: { invoice: UnifiedInvoice }) {
  return (
    <div className="border-border flex items-center justify-between border-b py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <FileText className="text-muted-foreground h-4 w-4" />
        <div className="min-w-30">
          <div className="text-sm font-medium">
            {invoice.number || `Invoice ${invoice.id.slice(-8)}`}
          </div>
          <div className="text-muted-foreground text-xs">
            {formatDate(invoice.created)} • {invoice.status}
          </div>
        </div>
        {invoice.description && (
          <div className="text-muted-foreground pl-10 text-center text-sm">
            {invoice.description}
          </div>
        )}
      </div>
      <div className="flex-1 px-4"></div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm font-medium">
            {formatCurrency(invoice.amount_due, invoice.currency)}
          </div>
        </div>
        <Badge variant="secondary-outline" className="w-16 text-xs">
          {invoice.invoice_type === 'seats' ? 'Seats' : 'Top-up'}
        </Badge>

        {invoice.hosted_invoice_url && (
          <a
            href={invoice.hosted_invoice_url}
            target="_blank"
            className="inline-flex items-center gap-1 text-sm text-blue-600 transition-colors hover:text-blue-300"
          >
            View
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {invoice.invoice_pdf && (
          <a
            href={invoice.invoice_pdf}
            target="_blank"
            className="inline-flex items-center gap-1 text-sm text-blue-600 transition-colors hover:text-blue-300"
          >
            PDF
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

export function OrganizationInvoicesCard({ organizationId, timePeriod = 'month' }: Props) {
  const { data: invoices, isLoading, error } = useOrganizationInvoices(organizationId, timePeriod);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-destructive text-sm">Failed to load invoices: {error.message}</div>
        </CardContent>
      </Card>
    );
  }

  // Sort invoices by most recent (created timestamp descending)
  const sortedInvoices = invoices?.slice().sort((a, b) => b.created - a.created) || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <DollarSign className="mr-2 inline h-5 w-5" />
          Invoices
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="border-border flex items-center justify-between border-b py-3 last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4" />
                  <div>
                    <Skeleton className="mb-1 h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Skeleton className="h-4 w-16" />
                  <div className="flex gap-2">
                    <Skeleton className="h-4 w-8" />
                    <Skeleton className="h-4 w-6" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : sortedInvoices.length === 0 ? (
          <div className="text-muted-foreground py-4 text-sm">
            No invoices found for this organization.
          </div>
        ) : (
          <div className="space-y-0">
            {sortedInvoices.map(invoice => (
              <InvoiceRow key={invoice.id} invoice={invoice} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
