'use client';

import AdminPage from '@/app/admin/components/AdminPage';
import RequestLoggingOptInsContent from '@/app/admin/request-logging-opt-ins/RequestLoggingOptInsContent';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Request Logging Opt-ins</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function RequestLoggingOptInsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <RequestLoggingOptInsContent />
    </AdminPage>
  );
}
