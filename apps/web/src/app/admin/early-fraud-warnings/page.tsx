import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { EarlyFraudWarningsContent } from './EarlyFraudWarningsContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Early Fraud Warnings</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function EarlyFraudWarningsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <EarlyFraudWarningsContent />
    </AdminPage>
  );
}
