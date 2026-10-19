import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { AdminActionAuditLogContent } from './AdminActionAuditLogContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Admin Action Log</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function AdminActionAuditLogPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <AdminActionAuditLogContent />
    </AdminPage>
  );
}
