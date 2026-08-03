import { ReceiptText } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function OrgKiloPassBillingHistoryCard({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ReceiptText className="size-5" aria-hidden />
              Billing history
            </CardTitle>
            <p className="mt-1 type-body text-muted-foreground">
              Invoices containing Kilo Pass for Organizations charges.
            </p>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
