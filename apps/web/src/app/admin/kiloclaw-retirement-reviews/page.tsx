import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { CommitRetirementReviewsContent } from './CommitRetirementReviewsContent';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Commit retirement reviews</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function CommitRetirementReviewsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <CommitRetirementReviewsContent />
    </AdminPage>
  );
}
