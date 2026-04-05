'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Download, Mail } from 'lucide-react';
import type { UnifiedInvoice } from '@/types/billing';
import { formatCents, formatDate } from '@/lib/utils';
import { ChangeBillingEmailDialog } from '@/components/invoices/ChangeBillingEmailDialog';
import { PageLayout } from '@/components/PageLayout';

const getStatusColor = (status: string) => {
  switch (status) {
    case 'paid':
      return 'bg-green-900/20 text-green-400';
    case 'open':
      return 'bg-yellow-900/20 text-yellow-400';
    case 'draft':
      return 'bg-gray-800 text-gray-300';
    case 'void':
      return 'bg-red-900/20 text-red-400';
    default:
      return 'bg-gray-800 text-gray-300';
  }
};

export function InvoicesPageClient({ invoices }: { invoices: UnifiedInvoice[] }) {
  return (
    <PageLayout
      title="Invoices"
      headerActions={
        <ChangeBillingEmailDialog>
          <Button variant="outline" size="sm">
            <Mail className="mr-2 h-4 w-4" />
            Change Billing Email
          </Button>
        </ChangeBillingEmailDialog>
      }
    >
      {invoices.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-muted-foreground">No invoices found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {invoices.map(invoice => (
            <Card key={invoice.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">
                        Invoice {invoice.number || invoice.id.slice(-8)}
                      </CardTitle>
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {formatDate(invoice.created)}
                    </p>
                  </div>
                  <Badge className={getStatusColor(invoice.status)}>
                    {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold">
                      {formatCents(invoice.amount_due, invoice.currency)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {invoice.hosted_invoice_url && (
                      <Button asChild variant="outline" size="sm">
                        <a href={invoice.hosted_invoice_url} target="_blank">
                          <ExternalLink className="mr-2 h-4 w-4" />
                          View
                        </a>
                      </Button>
                    )}
                    {invoice.invoice_pdf && (
                      <Button asChild variant="outline" size="sm">
                        <a href={invoice.invoice_pdf} target="_blank">
                          <Download className="mr-2 h-4 w-4" />
                          PDF
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageLayout>
  );
}
