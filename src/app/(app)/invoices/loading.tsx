import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react';
import { PageLayout } from '@/components/PageLayout';

export default function InvoicesLoading() {
  return (
    <PageLayout
      title="Invoices"
      headerActions={
        <Button variant="outline" size="sm" className="disabled opacity-50">
          <Mail className="mr-2 h-4 w-4" />
          Change Billing Email
        </Button>
      }
    >
      {/* Invoice cards skeleton */}
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-6 w-32" /> {/* Invoice title */}
                  </div>
                  <Skeleton className="mt-1 h-4 w-24" /> {/* Date */}
                </div>
                <Skeleton className="h-6 w-12 rounded-full" /> {/* Status badge */}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <Skeleton className="h-8 w-20" /> {/* Amount */}
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-16" /> {/* View button */}
                  <Skeleton className="h-8 w-14" /> {/* PDF button */}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PageLayout>
  );
}
