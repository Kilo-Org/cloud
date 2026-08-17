import { Suspense } from 'react';

import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Skeleton } from '@/components/ui/skeleton';
import { DataExportsContent } from './DataExportsContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Data export health</BreadcrumbPage>
  </BreadcrumbItem>
);

function DataExportsFallback() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-96 w-full rounded-lg" />
    </div>
  );
}

export default function DataExportsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<DataExportsFallback />}>
        <DataExportsContent />
      </Suspense>
    </AdminPage>
  );
}
