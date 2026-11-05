import { redirect } from 'next/navigation';
import { requireAdminPage, AdminStepUpGate } from '@/lib/admin/require-admin-page';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { userIsSuperadmin } from '@/lib/admin/admin-permissions';
import { AdminActionAuditLogContent } from './AdminActionAuditLogContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Admin Action Log</BreadcrumbPage>
  </BreadcrumbItem>
);

export default async function AdminActionAuditLogPage() {
  const adminAccess = await requireAdminPage();
  if (!adminAccess.user) {
    return <AdminStepUpGate requirement={adminAccess.stepUp} />;
  }
  if (!userIsSuperadmin(adminAccess.user)) {
    redirect('/admin/unauthorized');
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <AdminActionAuditLogContent />
    </AdminPage>
  );
}
