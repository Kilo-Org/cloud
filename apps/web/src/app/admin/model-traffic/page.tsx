import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { ModelTrafficContent } from './ModelTrafficContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Model Traffic</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function ModelTrafficPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <ModelTrafficContent />
    </AdminPage>
  );
}
