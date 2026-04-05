import { CreditCategoriesTable } from './CreditCategoriesTable';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Credit Categories</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function CreditCategoriesPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <CreditCategoriesTable />
    </AdminPage>
  );
}
