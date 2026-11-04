import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
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
  const { user } = await getUserFromAuth({ adminOnly: true });
  if (!user || !userIsSuperadmin(user)) {
    redirect('/admin/unauthorized');
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <AdminActionAuditLogContent />
    </AdminPage>
  );
}
