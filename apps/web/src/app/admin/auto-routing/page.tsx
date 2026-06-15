import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import AdminPage from '@/app/admin/components/AdminPage';
import { AutoRoutingAdminContent } from './AutoRoutingAdminContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Auto Routing</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function AutoRoutingAdminPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <AutoRoutingAdminContent />
    </AdminPage>
  );
}
