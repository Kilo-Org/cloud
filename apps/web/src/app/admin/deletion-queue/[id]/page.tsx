import { Suspense } from 'react';

import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Skeleton } from '@/components/ui/skeleton';
import { DeletionQueueDetailContent } from './DeletionQueueDetailContent';

function DetailFallback() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}

export default async function DeletionQueueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/deletion-queue">Deletion queue</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Request {id.slice(0, 8)}…</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<DetailFallback />}>
        <DeletionQueueDetailContent requestId={id} />
      </Suspense>
    </AdminPage>
  );
}
