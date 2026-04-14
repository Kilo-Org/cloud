import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

export default function ModelStatusPage() {
  return (
    <AdminPage
      breadcrumbs={
        <BreadcrumbItem>
          <BreadcrumbPage>Model Status</BreadcrumbPage>
        </BreadcrumbItem>
      }
    >
      <p>Under construction</p>
    </AdminPage>
  );
}
