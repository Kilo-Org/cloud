import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import AdminPage from '@/app/admin/components/AdminPage';
import { ModelEvalIngestContent } from './ModelEvalIngestContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Model Benchmarks</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function ModelEvalIngestPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <ModelEvalIngestContent />
    </AdminPage>
  );
}
