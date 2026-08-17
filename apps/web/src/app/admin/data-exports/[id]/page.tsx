import React, { Suspense } from 'react';

import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Skeleton } from '@/components/ui/skeleton';
import { DataExportDetailContent } from './DataExportDetailContent';

function DetailFallback() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-56 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export default async function DataExportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const exportId = id;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/data-exports">Data export health</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Export {exportId.slice(0, 8)}…</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<DetailFallback />}>
        <DataExportDetailContent exportId={exportId} />
      </Suspense>
    </AdminPage>
  );
}
