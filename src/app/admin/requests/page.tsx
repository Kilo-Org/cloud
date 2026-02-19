import { Suspense } from 'react';
import { RequestsTable } from '../components/RequestsTable';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>API Requests</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function RequestsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading API requests...</div>}>
        <RequestsTable />
      </Suspense>
    </AdminPage>
  );
}
