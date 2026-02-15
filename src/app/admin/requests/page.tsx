import { Suspense } from 'react';
import { RequestLogsTable } from '../components/RequestLogsTable';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Request Logs</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function RequestLogsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading request logs...</div>}>
        <RequestLogsTable />
      </Suspense>
    </AdminPage>
  );
}
