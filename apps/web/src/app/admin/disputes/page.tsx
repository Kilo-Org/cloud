import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { DisputesContent } from './DisputesContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Disputes</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function DisputesPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <DisputesContent />
    </AdminPage>
  );
}
