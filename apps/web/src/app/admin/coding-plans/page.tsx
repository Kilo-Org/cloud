import AdminPage from '@/app/admin/components/AdminPage';
import { CodingPlansOperationsContent } from '@/app/admin/coding-plans/CodingPlansOperationsContent';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

export default function AdminCodingPlansPage() {
  return (
    <AdminPage
      breadcrumbs={
        <BreadcrumbItem>
          <BreadcrumbPage>Coding plans</BreadcrumbPage>
        </BreadcrumbItem>
      }
    >
      <CodingPlansOperationsContent />
    </AdminPage>
  );
}
